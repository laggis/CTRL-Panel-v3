const bcrypt = require('bcrypt');

async function generateHash() {
    const password = 'Darkandd94!';
    const hash = await bcrypt.hash(password, 10);
    console.log('Password Hash:', hash);
}

generateHash();
