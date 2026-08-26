// agent-schema — `opts.schema` for hosts whose model has no structured-output tool (helm-006).
//
// Under a workflow runtime that owns the model, a schema forces a tool call and validation happens at
// the tool-call layer. A local model behind an OpenAI-compatible endpoint has no such flag: the run
// prints final response text and nothing else. So the host does the whole job itself —
// INSTRUCT -> EXTRACT -> VALIDATE -> RETRY -> null.
//
// The shape of this module is dictated by what these models actually do, which is not "fail to follow
// instructions". They answer correctly and then talk around the answer: a PASS followed by three
// sentences about a throwaway verification script, a branch and hash followed by a paragraph
// qualifying what "verified" meant. That narration is not noise to suppress — it is where
// verify_summary and notes come from. Extraction therefore tolerates prose on BOTH sides of the
// object, and never trusts `JSON.parse(stdout)`.
//
// Reasoning blocks are the second hazard: a thinking-mode model may emit one before the answer, so
// every extraction rule below scans from the END of the output, never the start.
//
// Deliberately NOT done here: grammar-constrained decoding (GBNF). llama.cpp can constrain output to
// a JSON schema outright, which would make extraction unnecessary — but it is a llama.cpp-only path,
// and a host serving both llama.cpp and SGLang models would then behave differently under the same
// `opts.schema`, with one side untested. Prompt-and-parse works on both. Measure the retry rate
// first; revisit grammars only for the llama.cpp side, with eyes open about the split.

'use strict'

// ---------------------------------------------------------------------------- instruct

// Tail placement is deliberate: these models honour the LAST instruction best, and the harness rules
// at the head of an engine prompt must stay first.
function schemaInstruction (schema) {
  return [
    '',
    '---',
    '',
    'OUTPUT FORMAT — this part is mechanical, and the run is discarded if it is not followed.',
    '',
    'Your reply must END with a single fenced ```json block containing exactly one JSON object that',
    'validates against this schema:',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'A worked example of the shape (values are illustrative, not answers):',
    '',
    '```json',
    JSON.stringify(exampleFor(schema), null, 2),
    '```',
    '',
    'Prose BEFORE the block is fine and often useful — reason there if you need to. Nothing may come',
    'after the closing fence. Every `enum` value must be copied exactly as written above; a near-miss',
    'synonym is a failure, not a paraphrase.',
  ].join('\n')
}

// A worked example beats a schema alone on small models — it settles nesting and array-ness, which is
// where they guess. Built from the schema so it can never drift from it.
function exampleFor (schema) {
  if (!schema || typeof schema !== 'object') return null
  switch (schema.type) {
    case 'object': {
      const out = {}
      const props = schema.properties || {}
      for (const k of Object.keys(props)) out[k] = exampleFor(props[k])
      return out
    }
    case 'array':
      return [exampleFor(schema.items)]
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return true
    case 'string':
    default:
      if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
      return '<string>'
  }
}

// ---------------------------------------------------------------------------- extract

// Ordered, first success wins. Every rule reads from the end of the output.
//   1. last fenced ```json block
//   2. last fenced block of any language
//   3. last balanced {...} span  (brace counting, string- and escape-aware — a regex cannot do this)
//   4. the whole of stdout
// Returns { value, rule, trailing } or { error, rule: 'none' }.
function extractJson (text) {
  const src = String(text == null ? '' : text)
  const attempts = [
    ['fenced-json', lastFence(src, /^[ \t]*```[ \t]*(?:json|jsonc|JSON)[ \t]*$/)],
    ['fenced-any', lastFence(src, /^[ \t]*```[a-zA-Z0-9_+-]*[ \t]*$/)],
    ['balanced-braces', lastBalancedObject(src)],
    ['whole-stdout', { body: src.trim(), end: src.length }],
  ]
  let firstError = null
  for (const [rule, hit] of attempts) {
    if (!hit || !hit.body) continue
    try {
      const value = JSON.parse(hit.body)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        firstError = firstError || `${rule}: parsed a ${Array.isArray(value) ? 'array' : typeof value}, not an object`
        continue
      }
      // An object lifted out of a surrounding array is NOT a result: picking one element of a list
      // the model meant as a list would silently answer a different question. Reject and let the
      // retry ask for a single object.
      if (rule === 'balanced-braces' && precededByArrayOpener(src, hit.start)) {
        firstError = firstError || 'balanced-braces: the object is an element of an array, not the result'
        continue
      }
      // Prose after the object is a signal, not an error — the model usually appends a caveat.
      const trailing = src.slice(hit.end).trim()
      return { value, rule, trailing }
    } catch (e) {
      firstError = firstError || `${rule}: ${e.message}`
    }
  }
  return { error: firstError || 'no JSON object found in the output', rule: 'none' }
}

// Last ```<lang> ... ``` pair whose opening fence matches `openRe`.
function lastFence (src, openRe) {
  const lines = src.split('\n')
  const closeRe = /^[ \t]*```[ \t]*$/
  // Walk backwards: find a closing fence, then the nearest matching opener above it.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!closeRe.test(lines[i]) && !openRe.test(lines[i])) continue
    if (!/^[ \t]*```/.test(lines[i])) continue
    for (let j = i - 1; j >= 0; j--) {
      if (!openRe.test(lines[j])) continue
      const body = lines.slice(j + 1, i).join('\n').trim()
      if (!body) break
      const end = lines.slice(0, i + 1).join('\n').length
      return { body, end }
    }
  }
  return null
}

// Last balanced {...} span, skipping braces inside strings and honouring backslash escapes.
function lastBalancedObject (src) {
  for (let start = src.lastIndexOf('{'); start >= 0; start = src.lastIndexOf('{', start - 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < src.length; i++) {
      const c = src[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return { body: src.slice(start, i + 1), end: i + 1, start }
      }
    }
  }
  return null
}

// Nearest non-whitespace character before the object: `[` or `,` means we are inside a list.
function precededByArrayOpener (src, start) {
  for (let i = start - 1; i >= 0; i--) {
    const c = src[i]
    if (/\s/.test(c)) continue
    return c === '[' || c === ','
  }
  return false
}

// ---------------------------------------------------------------------------- validate

// The subset the engines actually use: type (object/array/string/number/integer/boolean), properties,
// items, required, enum. Validation is real, not a shape sniff — the engines branch on exact enum
// strings, so a `status` of "complete" where the enum says "done" must FAIL rather than pass through
// and silently take the wrong branch.
function validate (value, schema, pathPrefix) {
  const errors = []
  walk(value, schema, pathPrefix || '$', errors)
  return errors
}

function walk (value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return
  const t = schema.type

  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: expected object, got ${describe(value)}`)
      return
    }
    for (const key of schema.required || []) {
      if (!(key in value) || value[key] === undefined || value[key] === null) {
        errors.push(`${path}.${key}: required, and it is ${key in value ? 'null' : 'missing'}`)
      }
    }
    const props = schema.properties || {}
    for (const key of Object.keys(props)) {
      if (value[key] === undefined || value[key] === null) continue // absent optional — fine
      walk(value[key], props[key], `${path}.${key}`, errors)
    }
    return
  }

  if (t === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array, got ${describe(value)}`)
      return
    }
    if (schema.items) value.forEach((v, i) => walk(v, schema.items, `${path}[${i}]`, errors))
    return
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`)
      return
    }
  }

  if (t === 'string' && typeof value !== 'string') errors.push(`${path}: expected string, got ${describe(value)}`)
  else if ((t === 'number' || t === 'integer') && typeof value !== 'number') errors.push(`${path}: expected ${t}, got ${describe(value)}`)
  else if (t === 'integer' && typeof value === 'number' && !Number.isInteger(value)) errors.push(`${path}: expected integer, got ${value}`)
  else if (t === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${describe(value)}`)
}

function describe (v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ---------------------------------------------------------------------------- retry

// Escalating specificity, same model, no shared conversation. Attempt 1 is the tail instruction
// above; 2 quotes the failure back verbatim; 3 withdraws the permission to narrate at all.
function retryInstruction (attempt, failure) {
  if (attempt === 2) {
    return [
      '',
      '---',
      '',
      'A previous attempt at this exact task was REJECTED by the caller\'s parser:',
      '',
      failure,
      '',
      'Do the task again and reply with the JSON object only, inside one ```json fence. Keep any',
      'explanation to a single sentence before the fence.',
    ].join('\n')
  }
  return [
    '',
    '---',
    '',
    'Two previous attempts were REJECTED. The last failure was:',
    '',
    failure,
    '',
    'Output EXACTLY one JSON object and nothing else: no prose, no code fence, no preamble, no',
    'trailing remark. The first character of your reply must be `{` and the last must be `}`.',
  ].join('\n')
}

module.exports = { schemaInstruction, exampleFor, extractJson, validate, retryInstruction }
