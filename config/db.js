const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // database: process.env.DB_NAME,
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

pool.getConnection()
    .then(conn => {
        console.log('Successfully connected the MariaDB via pool.');
        conn.release();
    }) 
    .catch(err => {
        console.error('Error connecting to MariaDB:', err.message);
        
    });

    module.exports = pool;