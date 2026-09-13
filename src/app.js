const express = require('express')

const apiRouter = require('./routes')

const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

app.use('/api', apiRouter)

app.use((req, res) => {
  res.status(404).json({
    code: 404,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  })
})

app.use((error, req, res, next) => {
  if (!error.status || error.status >= 500) {
    console.error(error)
  }
  res.status(error.status || 500).json({
    code: error.code || error.status || 500,
    message: error.message || 'Internal server error',
    ...(error.details !== undefined ? { details: error.details } : {}),
  })
})

module.exports = app
