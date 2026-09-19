const mysql = require('mysql2/promise')

const { database } = require('./config')

const pool = mysql.createPool({
  host: database.host,
  port: database.port,
  user: database.user,
  password: database.password,
  database: database.name,
  waitForConnections: true,
  connectionLimit: database.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+08:00',
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : undefined
})

async function checkDatabaseConnection() {
  const [rows] = await pool.query('SELECT 1 AS connected')
  return rows[0].connected === 1
}

module.exports = {
  checkDatabaseConnection,
  pool,
}
