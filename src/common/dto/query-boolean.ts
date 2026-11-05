import type { TransformFnParams } from 'class-transformer';

/**
 * A boolean query-string flag: true only for `true` / "true".
 *
 * `@Type(() => Boolean)` runs `Boolean(value)`, and every non-empty string is
 * truthy — so `?noArea=false` arrived as `true` and returned the opposite of
 * what was asked. The global pipe's `enableImplicitConversion` does the same
 * cast BEFORE a @Transform runs, so `value` is already wrong by then: this
 * reads the raw value off the source object instead.
 *
 * Use with `@Transform(queryBoolean)` on query DTOs.
 */
export function queryBoolean({ obj, key }: TransformFnParams): boolean | undefined {
  const raw = (obj as Record<string, unknown> | undefined)?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return raw === true || raw === 'true';
}
