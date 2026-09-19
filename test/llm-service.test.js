const assert = require('node:assert/strict')
const { afterEach, test } = require('node:test')

const { llm } = require('../src/config')
const { callChatCompletion } = require('../src/services/llm-service')

const originalFetch = global.fetch
const originalConfig = { ...llm }

afterEach(() => {
  global.fetch = originalFetch
  Object.assign(llm, originalConfig)
})

function networkError(code) {
  const error = new TypeError('fetch failed')
  error.cause = { code }
  return error
}

test('callChatCompletion retries one transient network failure', async () => {
  llm.apiKey = 'test-key'
  llm.defaultModel = 'test-model'
  let requestCount = 0
  global.fetch = async () => {
    requestCount += 1
    if (requestCount === 1) throw networkError('ECONNRESET')
    return {
      ok: true,
      json: async () => ({
        model: 'test-model',
        choices: [{ message: { content: 'success' } }],
        usage: {},
      }),
    }
  }

  const result = await callChatCompletion({ userPrompt: 'hello' })

  assert.equal(requestCount, 2)
  assert.equal(result.content, 'success')
})

test('callChatCompletion reports a persistent network failure as LLM_NETWORK_ERROR', async () => {
  llm.apiKey = 'test-key'
  llm.defaultModel = 'test-model'
  let requestCount = 0
  global.fetch = async () => {
    requestCount += 1
    throw networkError('ETIMEDOUT')
  }

  await assert.rejects(
    callChatCompletion({ userPrompt: 'hello' }),
    (error) => (
      error.status === 502 &&
      error.code === 'LLM_NETWORK_ERROR' &&
      error.message.includes('ETIMEDOUT')
    ),
  )
  assert.equal(requestCount, 2)
})

test('callChatCompletion rejects empty content that exhausted max_tokens', async () => {
  llm.apiKey = 'test-key'
  llm.defaultModel = 'test-model'
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      model: 'test-model',
      choices: [{ finish_reason: 'length', message: { content: '' } }],
      usage: { completion_tokens: 2048 },
    }),
  })

  await assert.rejects(
    callChatCompletion({ userPrompt: 'hello', maxTokens: 2048 }),
    (error) => (
      error.status === 502 &&
      error.code === 'EMPTY_LLM_RESPONSE' &&
      error.message.includes('increase the model node maximum output length')
    ),
  )
})
