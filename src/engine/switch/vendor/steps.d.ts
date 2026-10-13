/** Types for GB-Link-Switch-LDN web/js/cable/steps.js (vendored unchanged). */

export class StepFollower {
  constructor(out: (code: number) => void);
  reset(): void;
  report(code: number, counter: number): void;
  frame(code: number): void;
}
