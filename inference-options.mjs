const values = {
  serviceTier: ['auto', 'default', 'fast'],
  cyberAccessProgram: ['auto', 'standard', 'daybreak_blue', 'daybreak_red'],
};

/** `auto` preserves the original request: omit the field, let the server decide. */
export function normalizeInferenceOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(values, key))) {
    throw new Error('推理设置格式无效。');
  }
  const result = {};
  for (const [key, allowed] of Object.entries(values)) {
    const selected = Object.hasOwn(value, key) ? value[key] : 'auto';
    if (!allowed.includes(selected)) throw new Error(`不支持的推理设置：${key}。`);
    result[key] = selected;
  }
  return result;
}
