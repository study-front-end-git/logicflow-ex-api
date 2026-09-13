const fs = require('node:fs/promises')
const path = require('node:path')

const { pool } = require('../src/database')

async function main() {
  const sqlDirectory = path.join(__dirname, '..', 'sql')
  const sqlFiles = (await fs.readdir(sqlDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const sqlFile of sqlFiles) {
    const source = await fs.readFile(path.join(sqlDirectory, sqlFile), 'utf8')
    const statements = source
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)

    for (const statement of statements) {
      await pool.query(statement)
    }
    console.log(`Applied ${sqlFile}`)
  }

  console.log('Database initialized successfully')
}

main()
  .catch((error) => {
    console.error(`Database initialization failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(() => pool.end())
