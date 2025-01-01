let scripts = [];
let scriptHistory = [];

function updateScriptsList() {
    const scriptsListDiv = document.getElementById('scriptsList');
    scriptsListDiv.innerHTML = '';
    
    scripts.forEach(script => {
        const scriptDiv = document.createElement('div');
        scriptDiv.className = 'script-item';
        
        scriptDiv.innerHTML = `
            <div class="script-info">
                <strong>${script.name}</strong>
                <div class="script-details">
                    <span class="status-badge status-${script.status.toLowerCase()}">${script.status}</span>
                    <small>${script.type} - ${script.path}</small>
                </div>
            </div>
            <div class="script-controls">
                <button onclick="stopScript('${script.name}')" class="btn btn-danger">
                    <i class="fas fa-stop"></i> Stop
                </button>
                <button onclick="restartScript('${script.name}')" class="btn btn-primary">
                    <i class="fas fa-redo"></i> Restart
                </button>
            </div>
        `;
        
        scriptsListDiv.appendChild(scriptDiv);
    });
}

function updateHistoryList() {
    const historyListDiv = document.getElementById('historyList');
    if (!historyListDiv) return;

    historyListDiv.innerHTML = '';
    
    scriptHistory.forEach(script => {
        const historyDiv = document.createElement('div');
        historyDiv.className = 'history-item';
        
        const startTime = new Date(script.startTime).toLocaleString();
        const endTime = script.endTime ? new Date(script.endTime).toLocaleString() : 'N/A';
        
        historyDiv.innerHTML = `
            <div class="history-info">
                <strong>${script.name}</strong>
                <div class="history-details">
                    <small>Type: ${script.type}</small>
                    <small>Started: ${startTime}</small>
                    <small>Ended: ${endTime}</small>
                </div>
            </div>
            <div class="history-controls">
                <button onclick="deleteFromHistory('${script.name}')" class="btn btn-danger">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        
        historyListDiv.appendChild(historyDiv);
    });
}

async function addScript() {
    const name = document.getElementById('scriptName').value;
    const path = document.getElementById('scriptPath').value;
    const type = document.getElementById('scriptType').value;
    
    if (!name || !path) {
        alert('Please fill in all fields');
        return;
    }

    try {
        const response = await fetch('/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name,
                command: path,
                type
            })
        });

        const data = await response.json();
        
        if (response.ok) {
            scripts.push({ name, path, type, status: 'running' });
            updateScriptsList();
            loadHistory();
            
            // Clear input fields
            document.getElementById('scriptName').value = '';
            document.getElementById('scriptPath').value = '';
        } else {
            alert(data.error || 'Failed to start script');
        }
    } catch (error) {
        alert('Error starting script: ' + error.message);
    }
}

async function stopScript(name) {
    try {
        const response = await fetch('/stop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name })
        });

        const data = await response.json();
        
        if (response.ok) {
            scripts = scripts.filter(script => script.name !== name);
            updateScriptsList();
            loadHistory();
        } else {
            alert(data.error || 'Failed to stop script');
        }
    } catch (error) {
        alert('Error stopping script: ' + error.message);
    }
}

async function restartScript(name) {
    const script = scripts.find(s => s.name === name);
    if (!script) return;
    
    await stopScript(name);
    setTimeout(async () => {
        try {
            const response = await fetch('/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: script.name,
                    command: script.path,
                    type: script.type
                })
            });

            const data = await response.json();
            
            if (response.ok) {
                scripts.push({ ...script, status: 'running' });
                updateScriptsList();
                loadHistory();
            } else {
                alert(data.error || 'Failed to restart script');
            }
        } catch (error) {
            alert('Error restarting script: ' + error.message);
        }
    }, 1000);
}

async function loadHistory() {
    try {
        const response = await fetch('/history');
        if (response.ok) {
            scriptHistory = await response.json();
            updateHistoryList();
        }
    } catch (error) {
        console.error('Error loading history:', error);
    }
}

async function deleteFromHistory(name) {
    try {
        const response = await fetch(`/history/${name}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            scriptHistory = scriptHistory.filter(script => script.name !== name);
            updateHistoryList();
        } else {
            const data = await response.json();
            alert(data.error || 'Failed to delete from history');
        }
    } catch (error) {
        alert('Error deleting from history: ' + error.message);
    }
}

async function clearHistory() {
    const confirmed = confirm('Are you sure you want to clear the entire history?');
    if (!confirmed) return;

    try {
        const promises = scriptHistory
            .filter(script => !scripts.some(s => s.name === script.name))
            .map(script => deleteFromHistory(script.name));
        
        await Promise.all(promises);
        loadHistory();
    } catch (error) {
        alert('Error clearing history: ' + error.message);
    }
}

async function logout() {
    try {
        const response = await fetch('/logout', {
            method: 'POST'
        });

        if (response.ok) {
            window.location.href = '/';
        }
    } catch (error) {
        alert('Error logging out: ' + error.message);
    }
}

// Show/hide sections
function showSection(section) {
    document.getElementById('scripts-section').style.display = section === 'scripts' ? 'block' : 'none';
    document.getElementById('settings-section').style.display = section === 'settings' ? 'block' : 'none';
    document.getElementById('users-section').style.display = section === 'users' ? 'block' : 'none';

    // Update active link
    document.querySelectorAll('.sidebar a').forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('onclick').includes(section)) {
            link.classList.add('active');
        }
    });
}

// Change password
async function changePassword(event) {
    event.preventDefault();
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    if (newPassword !== confirmPassword) {
        alert('New passwords do not match!');
        return;
    }

    try {
        const response = await fetch('/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                currentPassword,
                newPassword
            })
        });

        const data = await response.json();
        if (data.success) {
            alert('Password changed successfully!');
            document.getElementById('change-password-form').reset();
        } else {
            alert(data.error || 'Failed to change password');
        }
    } catch (error) {
        alert('Error changing password');
    }
}

// Add new user
async function addUser(event) {
    event.preventDefault();
    const username = document.getElementById('newUsername').value;
    const password = document.getElementById('userPassword').value;
    const role = document.getElementById('userRole').value;

    try {
        const response = await fetch('/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                password,
                role
            })
        });

        const data = await response.json();
        if (data.success) {
            alert('User added successfully!');
            document.getElementById('add-user-form').reset();
            loadUsers();
        } else {
            alert(data.error || 'Failed to add user');
        }
    } catch (error) {
        alert('Error adding user');
    }
}

// Load users
async function loadUsers() {
    try {
        const response = await fetch('/users');
        const users = await response.json();
        const usersList = document.getElementById('users-list');
        usersList.innerHTML = '';

        users.forEach(user => {
            const userDiv = document.createElement('div');
            userDiv.className = 'user-item';
            userDiv.innerHTML = `
                <span>${user.username} (${user.role})</span>
                ${user.username !== 'admin' ? `
                    <button onclick="deleteUser('${user.username}')" class="btn btn-danger">
                        <i class="fas fa-trash"></i>
                    </button>
                ` : ''}
            `;
            usersList.appendChild(userDiv);
        });
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

// Delete user
async function deleteUser(username) {
    if (!confirm(`Are you sure you want to delete user ${username}?`)) {
        return;
    }

    try {
        const response = await fetch(`/users/${username}`, {
            method: 'DELETE'
        });

        const data = await response.json();
        if (data.success) {
            alert('User deleted successfully!');
            loadUsers();
        } else {
            alert(data.error || 'Failed to delete user');
        }
    } catch (error) {
        alert('Error deleting user');
    }
}

// Check if user is admin
async function checkAdminStatus() {
    try {
        const response = await fetch('/users');
        if (response.ok) {
            document.getElementById('adminUsersLink').style.display = 'block';
            loadUsers();
        }
    } catch (error) {
        console.error('Not an admin user');
    }
}

// Login function
async function login(event) {
    event.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorMessage = document.getElementById('error-message');

    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        if (response.ok) {
            window.location.href = '/dashboard.html';
        } else {
            const data = await response.json();
            errorMessage.textContent = data.error || 'Login failed';
        }
    } catch (error) {
        console.error('Login error:', error);
        errorMessage.textContent = 'An error occurred during login';
    }
}

// Call on page load
document.addEventListener('DOMContentLoaded', () => {
    refreshScripts();
    checkAdminStatus();
});

// Initial load
fetch('/status')
    .then(response => response.json())
    .then(status => {
        scripts = status;
        updateScriptsList();
        loadHistory();
    })
    .catch(error => console.error('Error fetching status:', error));
