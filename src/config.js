require('dotenv').config()

const port = Number.parseInt(process.env.PORT || '3000', 10)
const dbPort = Number.parseInt(process.env.DB_PORT || '3306', 10)
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:8080')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  cors: {
    origins: corsOrigins,
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },
  database: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: dbPort,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || 'logicflow',
    connectionLimit: Number.parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  },
  llm: {
    url: process.env.LLM_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions',
    apiKey: process.env.LLM_API_KEY || '',
    defaultModel: process.env.LLM_DEFAULT_MODEL || '',
    timeout: Number.parseInt(process.env.LLM_TIMEOUT || '60000', 10),
  },
  httpNode: {
    allowPrivateNetwork: process.env.HTTP_NODE_ALLOW_PRIVATE_NETWORK === 'true',
    maxResponseBytes: Number.parseInt(process.env.HTTP_NODE_MAX_RESPONSE_BYTES || '5242880', 10),
    maxTimeout: Number.parseInt(process.env.HTTP_NODE_MAX_TIMEOUT || '180000', 10),
  },
}
