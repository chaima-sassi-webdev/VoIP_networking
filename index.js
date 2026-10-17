require('dotenv').config();
const AsteriskManager = require('asterisk-manager');
const ari = require('ari-client');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// --------------------------------------------------
// 1. Configuration du serveur Web
// --------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serverClient: true,
  transports: ['polling', 'websocket']
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 4000;
const MONGO_URI = 'mongodb://127.0.0.1:27017/pfe_voip_db';

const CDR_FILE =
  '/var/lib/docker/volumes/40056d2362d814c705d7b1cfd5dcff15b599ad258d3754da200f011657004952/_data/cdr-csv/Master.csv';

// --------------------------------------------------
// 2. Modèle MongoDB
// --------------------------------------------------

const CallLogSchema = new mongoose.Schema({
  uniqueid: {
    type: String,
    required: true,
    unique: true
  },

  caller: String,
  destination: String,
  agent: String,
  type: String,

  duration: Number,
  billsec: Number,

  status: String,

  timestamp: {
    type: Date,
    default: Date.now
  }
});

const CallLog = mongoose.model('CallLog', CallLogSchema);

// Évite de retraiter plusieurs fois le même CDR pendant
// l'exécution actuelle du serveur.
const processedUniqueIds = new Set();

// Canaux actuellement suivis par ARI.
const activeCalls = new Map();
const internalCalls = new Map();
const internalCallByChannel = new Map();


// Publie la liste combinée des appels SVI et internes.
function publishActiveCalls() {
  const calls = [
    ...Array.from(activeCalls.values()),
    ...Array.from(internalCalls.values())
  ];

  io.emit('active_calls_updated', {
    count: calls.length,
    calls
  });
}

// --------------------------------------------------
// 3. Lecture d'une ligne CSV
// --------------------------------------------------

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      fields.push(value);
      value = '';
    } else {
      value += char;
    }
  }

  fields.push(value);

  return fields;
}

// --------------------------------------------------
// 4. Traitement des CDR Asterisk
// --------------------------------------------------

async function processCdrLine(line) {
  if (!line.trim()) return;

  const fields = parseCsvLine(line);

  // Format CSV observé dans notre installation Asterisk :
  // 0 accountcode
  // 1 src
  // 2 dst
  // 3 dcontext
  // 4 clid
  // 5 channel
  // 6 dstchannel
  // 7 lastapp
  // 8 lastdata
  // 9 start
  // 10 answer
  // 11 end
  // 12 duration
  // 13 billsec
  // 14 disposition
  // 15 amaflags
  // 16 uniqueid
  // 17 userfield

  if (fields.length < 17) return;

  const caller = fields[1];
  const destination = fields[2];
  const context = fields[3];
  const start = fields[9];
  const duration = Number(fields[12]) || 0;
  const billsec = Number(fields[13]) || 0;
  const status = fields[14];
  const uniqueid = fields[16];

  if (!uniqueid || processedUniqueIds.has(uniqueid)) {
    return;
  }

  const type =
    context === 'from-internal' ? 'Interne' : 'SVI / Externe';

  const record = {
    uniqueid,
    caller,
    destination,
    agent: destination,
    type,
    duration,
    billsec,
    status,
    timestamp: start ? new Date(start) : new Date()
  };

  try {
    // L'index unique sur uniqueid évite de créer deux
    // documents pour le même identifiant CDR.
    const result = await CallLog.updateOne(
      { uniqueid },
      { $setOnInsert: record },
      { upsert: true }
    );

    processedUniqueIds.add(uniqueid);

    if (result.upsertedCount > 0) {
      console.log(
        `📝 CDR enregistré : ${caller} -> ${destination} | ` +
        `${status} | ${duration}s`
      );

      io.emit('call_logged', record);
    }
  } catch (error) {
    if (error.code === 11000) {
      processedUniqueIds.add(uniqueid);
      return;
    }

    console.error('Erreur lors du traitement du CDR :', error.message);
  }
}

// Lecture du fichier complet au démarrage, puis des nouvelles lignes.
async function scanCdrFile() {
  try {
    const content = await fs.promises.readFile(CDR_FILE, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      await processCdrLine(line);
    }
  } catch (error) {
    console.error(
      'Erreur de lecture du fichier CDR :',
      error.message
    );
  }
}

// --------------------------------------------------
// 5. Routes API pour le dashboard
// --------------------------------------------------

// Historique des appels terminés.
app.get('/api/calls', async (req, res) => {
  try {
    const calls = await CallLog.find()
      .sort({ timestamp: -1 })
      .limit(200)
      .lean();

    res.json(calls);
  } catch (error) {
    console.error('Erreur de récupération de l’historique :', error);
    res.status(500).json({
      error: 'Impossible de récupérer l’historique.'
    });
  }
});

// État combiné des appels actifs suivis par ARI et AMI.
app.get('/api/active-calls', (req, res) => {
  const calls = [
    ...Array.from(activeCalls.values()),
    ...Array.from(internalCalls.values()).map(call => {
      const { channelIds, channelNames, ...publicCall } = call;
      return publicCall;
    })
  ];

  res.json(calls);
});

// --------------------------------------------------
// 6. Connexion ARI et suivi du SVI
// --------------------------------------------------

function connectARI() {
  ari.connect(
    process.env.ARI_URL,
    process.env.ARI_USER,
    process.env.ARI_PASSWORD,
    (err, client) => {
      if (err) {
        console.error('Erreur de connexion ARI :', err.message);
        console.log('Nouvelle tentative dans 5 secondes.');
        setTimeout(connectARI, 5000);
        return;
      }

      console.log('✅ Connecté à l’API ARI.');

      client.on('StasisStart', (event, channel) => {
        const call = {
          channel: channel.name,
          channelId: channel.id,
          caller: channel.caller?.number || 'Inconnu',
          destination: channel.dialplan?.exten || 'Inconnue',
          type: 'SVI',
          startedAt: Date.now()
        };

        activeCalls.set(channel.id, call);

        io.emit('call_started', call);
        publishActiveCalls();

        console.log(
          `📞 Appel SVI : ${call.caller} -> ${call.destination}`
        );

        channel.answer((answerError) => {
          if (answerError) {
            console.error(
              'Erreur de réponse à l’appel :',
              answerError.message
            );
          } else {
            console.log('☎️ Canal SVI décroché.');
          }
        });
      });

      client.on('StasisEnd', (event, channel) => {
        const call = activeCalls.get(channel.id);

        if (!call) return;

        activeCalls.delete(channel.id);

        const endedCall = {
          ...call,
          endedAt: Date.now(),
          elapsedSeconds: Math.floor(
            (Date.now() - call.startedAt) / 1000
          )
        };

        io.emit('call_ended', endedCall);

        publishActiveCalls();

        console.log(
          `☎️ Canal terminé : ${endedCall.caller} -> ` +
          `${endedCall.destination}`
        );
      });

      try {
        client.start('projet_pfe_voip');
        console.log('Application Stasis démarrée : projet_pfe_voip');
      } catch (startError) {
        console.error(
          'Erreur au démarrage de Stasis :',
          startError.message
        );
      }
    }
  );
}

// --------------------------------------------------
// 7. Connexion des superviseurs
// --------------------------------------------------

// --------------------------------------------------
// Connexion AMI et observation des événements Asterisk
// --------------------------------------------------

function connectAMI() {
  const amiHost = process.env.AMI_HOST || '127.0.0.1';
  const amiPort = Number(process.env.AMI_PORT || 5038);
  const amiUser = process.env.AMI_USER;
  const amiSecret = process.env.AMI_SECRET;

  if (!amiUser || !amiSecret) {
    console.error(
      '❌ AMI non démarré : AMI_USER ou AMI_SECRET manque dans .env.'
    );
    return;
  }

  const ami = new AsteriskManager(
    amiPort,
    amiHost,
    amiUser,
    amiSecret,
    true
  );

  function getOrCreateCall(key, event) {
    if (!key) return null;

    let call = internalCalls.get(key);

    if (!call) {
      call = {
        id: key,
        caller: '',
        destination: '',
        type: 'Interne',
        status: 'Sonnerie',
        startedAt: Date.now(),
        channelIds: [],
        channelNames: []
      };

      internalCalls.set(key, call);
    }

    const caller = String(event.calleridnum || '').trim();
    const destination = String(event.exten || '').trim();

    if (caller && caller !== '<unknown>') {
      call.caller = caller;
    }

    if (
      destination &&
      destination !== 's' &&
      destination !== 'h' &&
      destination !== 'i'
    ) {
      call.destination = destination;
    }

    return call;
  }

  function associateChannel(call, uniqueid, channel) {
    if (!call) return;

    if (uniqueid) {
      internalCallByChannel.set(String(uniqueid), call.id);

      if (!call.channelIds.includes(String(uniqueid))) {
        call.channelIds.push(String(uniqueid));
      }
    }

    if (channel) {
      internalCallByChannel.set(String(channel), call.id);

      if (!call.channelNames.includes(String(channel))) {
        call.channelNames.push(String(channel));
      }
    }
  }

  ami.on('connect', () => {
    console.log('✅ Connexion AMI établie.');
  });

  ami.on('managerevent', (event) => {
    const eventName = String(event.event || '').toLowerCase();

    const uniqueid = String(event.uniqueid || '');
    const linkedid = String(event.linkedid || '');
    const channel = String(event.channel || '');
    const destinationChannel = String(event.destchannel || '');

    const context = String(event.context || '');

    // On ne crée des appels que pour le contexte interne.
    // Les canaux déjà associés restent suivis jusqu'à leur fin.
    const knownKey =
      internalCallByChannel.get(uniqueid) ||
      internalCallByChannel.get(channel) ||
      internalCallByChannel.get(destinationChannel) ||
      '';

    const isInternal =
      context === 'from-internal' || Boolean(knownKey);

    if (!isInternal) return;

    if (eventName === 'newchannel' || eventName === 'dialbegin') {
      const key = linkedid || knownKey || uniqueid;
      const call = getOrCreateCall(key, event);

      if (call) {
        associateChannel(call, uniqueid, channel);

        if (destinationChannel) {
          associateChannel(call, '', destinationChannel);
        }

        if (eventName === 'dialbegin') {
          call.status = 'Sonnerie';
        }

        publishActiveCalls();
      }

      return;
    }

    const key = knownKey || linkedid || uniqueid;
    const call = internalCalls.get(key);

    if (!call) return;

    if (uniqueid || channel) {
      associateChannel(call, uniqueid, channel);
    }

    if (eventName === 'newstate') {
      const state = String(event.channelstatedesc || '').toLowerCase();

      if (state === 'up') {
        call.status = 'En communication';
      } else if (state === 'ring' || state === 'ringing') {
        call.status = 'Sonnerie';
      }

      publishActiveCalls();
      return;
    }

    if (eventName === 'bridgeenter') {
      call.status = 'En communication';
      publishActiveCalls();
      return;
    }

    if (eventName === 'dialend') {
      const dialStatus = String(event.dialstatus || '').toUpperCase();

      if (dialStatus && dialStatus !== 'ANSWER') {
        call.status = 'Appel non répondu';
      }

      publishActiveCalls();
      return;
    }

    if (eventName === 'hangup') {
      // Retire uniquement le canal qui vient de se terminer.
      if (uniqueid) {
        call.channelIds = call.channelIds.filter(
          id => id !== uniqueid
        );

        internalCallByChannel.delete(uniqueid);
      }

      if (channel) {
        call.channelNames = call.channelNames.filter(
          name => name !== channel
        );

        internalCallByChannel.delete(channel);
      }

      // L'appel reste actif tant qu'un autre canal lui appartient.
      if (call.channelIds.length === 0) {
        for (const name of call.channelNames) {
          internalCallByChannel.delete(name);
        }

        internalCalls.delete(call.id);
      }

      publishActiveCalls();
    }
  });

  ami.on('error', (error) => {
    console.error('❌ Erreur AMI :', error.message);
  });

  ami.keepConnected();
}

// --------------------------------------------------
// 8. Démarrage de l'application
// --------------------------------------------------

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);

    console.log('📦 Connecté à MongoDB.');

    await CallLog.init();

    console.log('🗄️ Modèle CallLog initialisé.');

    // Importer les CDR existants.
    await scanCdrFile();

    // Vérifier les nouvelles lignes toutes les 2 secondes.
    setInterval(scanCdrFile, 2000);

    server.listen(PORT, () => {
      console.log(
        `🚀 Dashboard disponible sur http://localhost:${PORT}`
      );
    });

    connectARI();
    connectAMI();
  } catch (error) {
    console.error(
      'Erreur au démarrage du serveur :',
      error.message
    );

    process.exitCode = 1;
  }
}

startServer();
