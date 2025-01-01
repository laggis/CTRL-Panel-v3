# Script Control Panel

A modern web-based control panel for managing and monitoring Node.js and Python scripts. This application provides a clean interface for starting, stopping, and monitoring scripts with persistent state management.

## Features

- 🚀 **Modern Web Interface**: Clean and responsive design
- 🔒 **Secure Authentication**: Password-protected access with user management
- 👥 **User Management**: Add, delete, and manage users with different roles
- 📊 **Script Management**: Start, stop, and monitor scripts
- 💾 **Persistent Storage**: Scripts and user data persist across server restarts
- 📝 **Script History**: Track all script executions and their status
- 🔄 **Auto-Restart**: Automatically restarts running scripts after server reboot
- 🌐 **Network Access**: Accessible from any device on the network

## Prerequisites

- Node.js (v14 or higher)
- Python (optional, for running Python scripts)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/script-control-panel.git
   cd script-control-panel
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   node server.js
   ```

The server will start on `http://0.0.0.0:3000`

## Configuration

### Default Login Credentials
- Username: `admin`
- Password: `admin`

It's recommended to change these credentials after first login using the Settings page.

### Adding Scripts

1. Access the web interface at `http://your-ip:3000`
2. Log in with your credentials
3. Use the "Add New Script" form:
   - Script Name: Give your script a unique name
   - Script Path: Full path to your script file
   - Type: Select Node.js or Python

### Managing Users

1. Log in as admin
2. Click on "Users" in the sidebar
3. Use the "Add New User" form to create users:
   - Username: Unique username
   - Password: Secure password
   - Role: User or Admin

## Directory Structure

```
script-control-panel/
├── data/
│   ├── scripts.json    # Scripts storage
│   └── users.json      # User data storage
├── public/
│   ├── dashboard.html  # Main interface
│   ├── index.html     # Login page
│   ├── script.js      # Client-side JavaScript
│   └── style.css      # Styling
├── server.js          # Main server file
├── package.json       # Dependencies
└── README.md         # Documentation
```

## Security Features

- Session-based authentication
- Password hashing with bcrypt
- Role-based access control (Admin/User)
- Protected API endpoints
- Secure password change functionality

## API Endpoints

### Authentication
- `POST /login` - Authenticate user
- `POST /logout` - End session
- `POST /change-password` - Change user password

### User Management (Admin only)
- `POST /users` - Add new user
- `GET /users` - List all users
- `DELETE /users/:username` - Delete user

### Script Management
- `POST /start` - Start a new script
- `POST /stop` - Stop a running script
- `GET /status` - Get status of all scripts
- `GET /history` - Get script execution history
- `DELETE /history/:name` - Delete script history

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
