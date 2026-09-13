const dns = require('node:dns').promises
const net = require('node:net')

const HttpError = require('./http-error')

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) return isPrivateIpv4(address)
  if (net.isIP(address) !== 6) return true

  const normalized = address.toLowerCase()
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice(7))
  }
  return normalized === '::' || normalized === '::1' ||
    normalized.startsWith('fc') || normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
}

async function resolveSafeAddress(hostname, allowPrivateNetwork = false) {
  const normalizedHost = hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(normalizedHost)
    ? [{ address: normalizedHost, family: net.isIP(normalizedHost) }]
    : await dns.lookup(normalizedHost, { all: true, verbatim: true })

  if (!addresses.length) {
    throw new HttpError(400, 'HTTP node hostname cannot be resolved', 'HTTP_NODE_DNS_FAILED')
  }
  if (!allowPrivateNetwork && addresses.some((item) => isPrivateAddress(item.address))) {
    throw new HttpError(400, 'HTTP node cannot access private or local network addresses', 'HTTP_NODE_PRIVATE_ADDRESS')
  }
  return addresses.find((item) => item.family === 4) || addresses[0]
}

module.exports = { isPrivateAddress, resolveSafeAddress }
