class HttpError extends Error {
  constructor(status, message, code = status, details) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

module.exports = HttpError
