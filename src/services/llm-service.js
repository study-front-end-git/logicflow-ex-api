const { llm } = require('../config')
const HttpError = require('../utils/http-error')

async function callChatCompletion(options) {
  if (!llm.apiKey) {
    throw new HttpError(500, 'LLM_API_KEY is not configured', 'LLM_NOT_CONFIGURED')
  }

  const model = options.model || llm.defaultModel
  if (!model) {
    throw new HttpError(400, 'The model node does not specify a model', 'MODEL_NOT_CONFIGURED')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), llm.timeout)

  try {
    const response = await fetch(llm.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(options.systemPrompt
            ? [{ role: 'system', content: options.systemPrompt }]
            : []),
          { role: 'user', content: options.userPrompt },
        ],
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: false,
      }),
    })

    const body = await response.json().catch(() => null)
    if (!response.ok) {
      console.error('Agnes API request failed:', response.status, body)
      throw new HttpError(
        502,
        body?.error?.message || body?.message || `Agnes API returned HTTP ${response.status}`,
        'LLM_REQUEST_FAILED',
      )
    }

    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new HttpError(502, 'Agnes API returned an invalid response', 'INVALID_LLM_RESPONSE')
    }

    return {
      content,
      model: body.model || model,
      usage: {
        promptTokens: body.usage?.prompt_tokens || 0,
        completionTokens: body.usage?.completion_tokens || 0,
        totalTokens: body.usage?.total_tokens || 0,
      },
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(504, 'Agnes API request timed out', 'LLM_TIMEOUT')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

module.exports = { callChatCompletion }
