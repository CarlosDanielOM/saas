// A recording built-in: the call's arguments (JSON), and the case's answer for it.
import { R, record, copy } from './rec.mjs';
export function builtin(name) {
  return async (...args) => {
    record('builtin', { function: name, args: copy(args) });
    const answer = R.config.builtins?.[name] ?? { error: false, message: `${name} answered` };
    if (answer.throws) throw new Error(answer.throws);
    return answer;
  };
}
