// 由 scripts/vendor-zod.ts 生成,勿手改。理由见那个脚本里的长注释。
import * as classic from './zod-v4.js'

export const object = classic.object
export const toJSONSchema = classic.toJSONSchema
export const safeParse = (schema, data) => classic.core.safeParse(schema, data)
export const safeParseAsync = (schema, data) => classic.core.safeParseAsync(schema, data)
