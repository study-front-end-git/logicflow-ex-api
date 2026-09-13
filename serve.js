const http = require('node:http')

const app = require('./src/app')
const { port } = require('./src/config')
const { checkDatabaseConnection, pool } = require('./src/database')

const server = http.createServer(app)

server.listen(port, () => {
  console.log(`LogicFlow API is running at http://localhost:${port}`)

  checkDatabaseConnection()
    .then(() => console.log('MySQL connected successfully'))
    .catch((error) => console.error(`MySQL connection failed: ${error.message}`))
})

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`)
  await pool.end()
  server.close((error) => process.exit(error ? 1 : 0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
