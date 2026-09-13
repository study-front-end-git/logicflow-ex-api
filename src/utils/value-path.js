function getValueAtPath(value, path) {
  if (!Array.isArray(path) || path.length === 0) return { found: true, value }

  const [pathPart, ...remainingPath] = path
  if (Array.isArray(value) && !Object.prototype.hasOwnProperty.call(value, pathPart)) {
    const resolvedItems = []
    for (const item of value) {
      const resolved = getValueAtPath(item, path)
      if (!resolved.found) return { found: false, value: undefined }
      resolvedItems.push(resolved.value)
    }
    return { found: true, value: resolvedItems }
  }

  if (
    value === null ||
    value === undefined ||
    !Object.prototype.hasOwnProperty.call(Object(value), pathPart)
  ) {
    return { found: false, value: undefined }
  }
  return getValueAtPath(value[pathPart], remainingPath)
}

module.exports = { getValueAtPath }
