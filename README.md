# Real-Time VoIP Monitoring Dashboard

A real-time VoIP monitoring dashboard built with Asterisk, Node.js, Socket.IO, and MongoDB.

This project aims to monitor VoIP calls, track their status, and display call information through a web-based dashboard.

## Overview

The application connects an Asterisk-based VoIP system to a Node.js backend and a web dashboard.

It is designed to provide real-time visibility into call activity and support the monitoring of SIP communications.

## Architecture

```text
SIP Softphone 101  <---->  Asterisk PBX  <---->  SIP Softphone 200
                              |
                              v
                       Node.js Backend
                              |
                    +---------+---------+
                    |                   |
                 REST API           Socket.IO
                    |                   |
                    +---------+---------+
                              |
                              v
                      Web Dashboard
                              |
                              v
                           MongoDB
```

## Features

- VoIP call monitoring through an Asterisk PBX.
- SIP extension registration and call handling.
- Node.js backend for communication with the VoIP system.
- Real-time dashboard updates using Socket.IO.
- REST API for retrieving active-call information.
- MongoDB integration for storing call-related records.
- Environment-based configuration for sensitive credentials.

## Technologies

| Technology | Purpose |
|---|---|
| Asterisk | VoIP telephony and SIP call management |
| SIP | Signaling between VoIP endpoints |
| Node.js | Backend application |
| JavaScript | Application development |
| Socket.IO | Real-time communication |
| REST API | Access to call information |
| MongoDB | Call-related data storage |
| HTML | Web dashboard interface |
| Git and GitHub | Version control and source code hosting |

## Project Structure

```text
VoIP_networking/
├── config-asterisk/       # Local Asterisk configuration
├── public/
│   └── index.html         # Web dashboard
├── index.js               # Node.js backend
├── package.json           # Project metadata and dependencies
├── package-lock.json      # Dependency lockfile
├── .gitignore             # Files excluded from Git
└── README.md              # Project documentation
```

Note: Sensitive Asterisk configuration files and local environment files are intentionally excluded from the public repository.

## Prerequisites

Before running the application, make sure you have:

- Node.js and npm installed.
- A configured Asterisk PBX.
- Registered SIP endpoints.
- A running MongoDB instance.
- The required Node.js dependencies installed.

## Installation and Configuration

### 1. Clone the repository

```bash
git clone https://github.com/chaima-sassi-webdev/VoIP_networking.git
cd VoIP_networking
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a local `.env` file in the project root.

Configure the required variables according to your local environment, including the appropriate ARI and AMI credentials and MongoDB connection settings.

Example structure:

```dotenv
ARI_USER=your_ari_username
ARI_PASSWORD=your_ari_password
AMI_USER=your_ami_username
AMI_SECRET=your_ami_secret
MONGO_URI=mongodb://127.0.0.1:27017/pfe_voip_db
```

Replace the example credentials with your own local values.

**Never commit your `.env` file or publish real credentials.**

### 4. Configure Asterisk

Configure Asterisk according to your environment, including:

- SIP extensions and endpoint authentication.
- Asterisk REST Interface (ARI), if required by the application.
- Asterisk Manager Interface (AMI), if required by the application.
- HTTP and WebSocket settings, where applicable.
- Call routing and dialplan configuration.

Ensure that the required interfaces are enabled and that the backend has the appropriate permissions to communicate with Asterisk.

### 5. Start the application

Start MongoDB and Asterisk first.

Then launch the Node.js backend using the start command defined in `package.json`.

Open the dashboard using the local address and port configured by the application.

## API

The backend exposes an endpoint for retrieving active calls:

```http
GET /api/active-calls
```

The dashboard can receive real-time active-call updates through Socket.IO using the `active_calls_updated` event.

The exact response format depends on the current backend implementation.

## Security

Security considerations for this project include:

- Keeping SIP credentials and interface passwords out of source control.
- Storing sensitive configuration in environment variables.
- Restricting access to Asterisk management interfaces.
- Using appropriate authentication and network access controls.
- Avoiding the publication of sensitive call records or personal information.

## Future Improvements

Potential improvements include:

- Enhanced call statistics and monitoring.
- Historical call analytics and reporting.
- Improved dashboard visualizations.
- More detailed error handling and connection monitoring.
- Authentication and role-based access control for dashboard users.
- Containerized deployment and automated testing.

## Author

**Chaima Sassi**

GitHub: [@chaima-sassi-webdev](https://github.com/chaima-sassi-webdev)

## License

No license has been specified yet. All rights are reserved unless a license is added to this repository.
