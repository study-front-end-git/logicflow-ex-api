const express = require('express')
const cors = require('cors')

const config = require('./config')
const apiRouter = require('./routes')
const HttpError = require('./utils/http-error')

const app = express()

app.disable('x-powered-by')
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.cors.origins.includes('*') || config.cors.origins.includes(origin)) {
      callback(null, true)
      return
    }

    callback(new HttpError(403, `Origin ${origin} is not allowed`, 'CORS_ORIGIN_NOT_ALLOWED'))
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: config.cors.credentials,
  optionsSuccessStatus: 204,
}))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

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
