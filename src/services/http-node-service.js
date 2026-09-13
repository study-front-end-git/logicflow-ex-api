const http = require('node:http')
const https = require('node:https')
const { randomBytes } = require('node:crypto')

const { httpNode: httpNodeConfig } = require('../config')
const HttpError = require('../utils/http-error')
const { resolveSafeAddress } = require('../utils/network-policy')
const { getValueAtPath } = require('../utils/value-path')

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'])

function resolveValue(item, variables) {
  if (item.valueType !== 'reference') return item.inputValue ?? ''
  const reference = item.referenceValue || item.referenceKey
  if (!Array.isArray(reference) || reference.length < 2) {
    throw new HttpError(400, `Invalid reference for ${item.key || item.name || 'parameter'}`, 'INVALID_VARIABLE_REFERENCE')
  }
  const resolved = getValueAtPath(variables?.[reference[0]], reference.slice(1))
  if (!resolved.found) {
    throw new HttpError(400, `Missing variable ${reference.join('.')}`, 'HTTP_NODE_TEST_VARIABLE_MISSING')
  }
  return resolved.value
}

function enabledItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && item.enabled !== false)
}

function setContentType(headers, value) {
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['Content-Type'] = value
}

function createBody(bodyConfig, variables, headers) {
  const body = bodyConfig || { type: 'none' }
  if (!body.type || body.type === 'none') return null

  if (body.type === 'raw') return String(body.raw ?? body.value ?? '')

  const values = Object.fromEntries(enabledItems(body.fields).map((item) => [item.key, resolveValue(item, variables)]))
  if (body.type === 'json') {
    setContentType(headers, 'application/json')
    return JSON.stringify(values)
  }
  if (body.type === 'x-www-form-urlencoded') {
    setContentType(headers, 'application/x-www-form-urlencoded;charset=UTF-8')
    return new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString()
  }
  if (body.type === 'form-data') {
    const boundary = `----LogicFlow${randomBytes(12).toString('hex')}`
    setContentType(headers, `multipart/form-data; boundary=${boundary}`)
    return Object.entries(values)
      .map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key.replaceAll('"', '%22')}"\r\n\r\n${String(value)}\r\n`)
      .join('') + `--${boundary}--\r\n`
  }
  throw new HttpError(400, `Unsupported HTTP body type: ${body.type}`, 'INVALID_HTTP_NODE_BODY')
}

async function buildRequest(config, variables = {}) {
  const method = String(config?.method || 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpError(400, `Unsupported HTTP method: ${method}`, 'INVALID_HTTP_NODE_METHOD')
  }
  if (!config?.url || typeof config.url !== 'string') {
    throw new HttpError(400, 'HTTP node URL is required', 'INVALID_HTTP_NODE_URL')
  }
  if (config.credentialId) {
    throw new HttpError(501, 'HTTP credential storage is not implemented yet', 'HTTP_CREDENTIAL_NOT_IMPLEMENTED')
  }

  let urlText = config.url
  for (const item of enabledItems(config.pathParams)) {
    const placeholder = `{${item.key}}`
    if (!urlText.includes(placeholder)) {
      throw new HttpError(400, `URL does not contain path parameter ${placeholder}`, 'HTTP_NODE_PATH_PARAMETER_MISSING')
    }
    urlText = urlText.replaceAll(placeholder, encodeURIComponent(String(resolveValue(item, variables))))
  }

  let url
  try {
    url = new URL(urlText)
  } catch (error) {
    throw new HttpError(400, 'HTTP node URL is invalid', 'INVALID_HTTP_NODE_URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new HttpError(400, 'Only HTTP(S) URLs without embedded credentials are allowed', 'INVALID_HTTP_NODE_URL')
  }
  for (const item of enabledItems(config.query)) {
    if (item.key) url.searchParams.append(item.key, String(resolveValue(item, variables)))
  }

  const headers = {}
  for (const item of enabledItems(config.headers)) {
    const name = String(item.key || '').trim()
    if (!name) continue
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw new HttpError(400, `Header ${name} is not allowed`, 'HTTP_NODE_HEADER_NOT_ALLOWED')
    }
    headers[name] = String(resolveValue(item, variables))
  }
  const body = ['GET', 'DELETE'].includes(method) ? null : createBody(config.body, variables, headers)
  return { body, headers, method, url }
}

function parseResponseBody(buffer, responseType, contentType) {
  if (responseType === 'binary') {
    return { base64: buffer.toString('base64'), contentType: contentType || 'application/octet-stream' }
  }
  const text = buffer.toString('utf8')
  if (responseType === 'text') return text
  try {
    return text ? JSON.parse(text) : null
  } catch (error) {
    throw new HttpError(502, 'Remote API did not return valid JSON', 'INVALID_HTTP_NODE_RESPONSE')
  }
}

async function sendRequest(requestConfig) {
  const address = await resolveSafeAddress(requestConfig.url.hostname, httpNodeConfig.allowPrivateNetwork)
  const timeout = Math.min(Math.max(Number(requestConfig.timeout) || 30000, 1000), httpNodeConfig.maxTimeout)
  const transport = requestConfig.url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    let timeoutId
    const finish = (callback, value) => {
      clearTimeout(timeoutId)
      callback(value)
    }
    const request = transport.request({
      protocol: requestConfig.url.protocol,
      hostname: requestConfig.url.hostname,
      port: requestConfig.url.port || undefined,
      path: `${requestConfig.url.pathname}${requestConfig.url.search}`,
      method: requestConfig.method,
      headers: requestConfig.headers,
      servername: requestConfig.url.hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) {
          callback(null, [{ address: address.address, family: address.family }])
          return
        }
        callback(null, address.address, address.family)
      },
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > httpNodeConfig.maxResponseBytes) {
          response.destroy(new HttpError(502, 'Remote response is too large', 'HTTP_NODE_RESPONSE_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => finish(resolve, {
        body: Buffer.concat(chunks),
        headers: response.headers,
        status: response.statusCode,
        statusText: response.statusMessage,
      }))
      response.on('error', (error) => finish(reject, error))
    })
    timeoutId = setTimeout(() => {
      request.destroy(new HttpError(504, `HTTP request timed out after ${timeout}ms`, 'HTTP_NODE_TIMEOUT'))
    }, timeout)
    request.on('error', (error) => finish(reject, error))
    if (requestConfig.body !== null) request.write(requestConfig.body)
    request.end()
  })
}

function getByPath(value, path) {
  if (!path) return value
  return String(path).split('.').reduce((current, key) => current?.[key], value)
}

function extractOutputs(body, outputDefinitions) {
  return enabledItems(outputDefinitions).reduce((result, item) => {
    if (typeof item.name !== 'string' || !item.name.trim()) return result
    let value = getByPath(body, item.responsePath)
    if (value === undefined || value === null) value = item.defaultValue
    if ((value === undefined || value === null) && item.required) {
      throw new HttpError(502, `Response path ${item.responsePath || '<root>'} was not found`, 'HTTP_NODE_OUTPUT_NOT_FOUND')
    }
    result[item.name] = value
    return result
  }, {})
}

function buildOutputOptions(data) {
  function build(value) {
    let currentValue = value
    if (Array.isArray(currentValue)) {
      currentValue = currentValue.find((item) => (
        Array.isArray(item) || (item !== null && typeof item === 'object')
      ))
    }
    if (currentValue === null || typeof currentValue !== 'object') return []

    return Object.entries(currentValue).map(([key, childValue]) => {
      const option = { value: key, label: key }
      const children = build(childValue)
      if (children.length) option.children = children
      return option
    })
  }

  return build(data)
}

function sanitizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    ['authorization', 'proxy-authorization', 'cookie', 'x-api-key'].includes(key.toLowerCase()) ? '***' : value,
  ]))
}

// function sanitizeUrl(urlValue) {
//   const url = new URL(urlValue)
//   for (const key of url.searchParams.keys()) {
//     if (/(?:access[_-]?key|api[_-]?key|token|secret|password|authorization|auth)/i.test(key)) {
//       url.searchParams.set(key, '***')
//     }
//   }
//   return url.toString()
// }

async function testHttpNode({ config, output, variables }) {
  const startedAt = Date.now()
  const prepared = await buildRequest(config, variables)
  const response = await sendRequest({ ...prepared, timeout: config.timeout })
  const parsedBody = parseResponseBody(response.body, config.responseType || 'json', response.headers['content-type'])
  const responseSummary = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    durationMs: Date.now() - startedAt,
    body: parsedBody,
  }
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(502, `Remote API returned HTTP ${response.status}`, 'HTTP_NODE_REQUEST_FAILED', responseSummary)
  }
  return {
    request: { method: prepared.method, url: prepared.url.toString(), headers: sanitizeHeaders(prepared.headers) },
    response: responseSummary,
    output: extractOutputs(parsedBody, output),
  }
}

module.exports = { buildOutputOptions, buildRequest, extractOutputs, testHttpNode }
