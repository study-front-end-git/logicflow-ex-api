const { llm } = require('../config')
const HttpError = require('../utils/http-error')

function isFetchNetworkError(error) {
  return error instanceof TypeError && error.message === 'fetch failed'
}

async function fetchWithNetworkRetry(url, options, attempts = 2) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options)
    } catch (error) {
      lastError = error
      if (!isFetchNetworkError(error) || attempt === attempts) throw error
    }
  }
  throw lastError
}

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
    const response = await fetchWithNetworkRetry(llm.url, {
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

    const choice = body?.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string') {
      throw new HttpError(502, 'Agnes API returned an invalid response', 'INVALID_LLM_RESPONSE')
    }

    const completionTokens = body.usage?.completion_tokens || 0
    if (!content.trim()) {
      const reachedTokenLimit = Number.isInteger(options.maxTokens) && completionTokens >= options.maxTokens
      throw new HttpError(
        502,
        reachedTokenLimit
          ? `Agnes API returned empty content after reaching max_tokens (${options.maxTokens}); increase the model node maximum output length`
          : 'Agnes API returned empty content',
        'EMPTY_LLM_RESPONSE',
        {
          completionTokens,
          finishReason: choice?.finish_reason || null,
          maxTokens: options.maxTokens,
        },
      )
    }

    return {
      content,
      finishReason: choice?.finish_reason || null,
      model: body.model || model,
      usage: {
        promptTokens: body.usage?.prompt_tokens || 0,
        completionTokens,
        totalTokens: body.usage?.total_tokens || 0,
      },
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(504, 'Agnes API request timed out', 'LLM_TIMEOUT')
    }
    if (isFetchNetworkError(error)) {
      const reason = error.cause?.code || error.cause?.message
      throw new HttpError(
        502,
        `Agnes API network request failed${reason ? `: ${reason}` : ''}`,
        'LLM_NETWORK_ERROR',
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

module.exports = { callChatCompletion, fetchWithNetworkRetry }
