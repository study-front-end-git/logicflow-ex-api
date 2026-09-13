const assert = require('node:assert/strict')
const { test } = require('node:test')

const { buildOutputOptions, buildRequest, extractOutputs } = require('../src/services/http-node-service')
const { isPrivateAddress } = require('../src/utils/network-policy')

test('buildRequest resolves path, query, headers and JSON body values', async () => {
  const request = await buildRequest({
    url: 'https://example.com/users/{userId}',
    method: 'POST',
    pathParams: [{ key: 'userId', valueType: 'input', inputValue: 'user 1' }],
    query: [{ key: 'detail', valueType: 'reference', referenceValue: ['start', 'options', 'detail'] }],
    headers: [{ key: 'X-Test', valueType: 'input', inputValue: 'yes' }],
    body: {
      type: 'json',
      fields: [{ key: 'name', valueType: 'reference', referenceValue: ['start', 'name'] }],
    },
  }, { start: { options: { detail: true }, name: 'Alice' } })

  assert.equal(request.url.toString(), 'https://example.com/users/user%201?detail=true')
  assert.equal(request.headers['X-Test'], 'yes')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.body, '{"name":"Alice"}')
})

test('extractOutputs reads configured response paths', () => {
  const output = extractOutputs(
    { data: { user: { name: 'Alice', age: 20 } } },
    [
      { name: 'username', responsePath: 'data.user.name', required: true },
      { name: 'age', responsePath: 'data.user.age', required: true },
    ],
  )
  assert.deepEqual(output, { username: 'Alice', age: 20 })
})

test('buildOutputOptions creates nested options and infers object array fields', () => {
  assert.deepEqual(buildOutputOptions({
    data: [{ id: 1, profile: { name: 'Alice' } }],
    total: 1,
  }), [
    {
      value: 'data',
      label: 'data',
      children: [
        { value: 'id', label: 'id' },
        {
          value: 'profile',
          label: 'profile',
          children: [{ value: 'name', label: 'name' }],
        },
      ],
    },
    { value: 'total', label: 'total' },
  ])
})

test('network policy identifies private addresses', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true)
  assert.equal(isPrivateAddress('192.168.1.10'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
  assert.equal(isPrivateAddress('::1'), true)
})
