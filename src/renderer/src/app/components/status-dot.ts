import { Component, computed, input } from '@angular/core';

export type DotColor = 'green' | 'amber' | 'red' | 'gray' | 'blue';

const DOT_CLASSES: Record<DotColor, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
  gray: 'bg-neutral-400 dark:bg-neutral-600',
  blue: 'bg-sky-500',
};

@Component({
  selector: 'app-status-dot',
  template: `<span class="inline-block h-2.5 w-2.5 rounded-full {{ cls() }}"></span>`,
})
export class StatusDot {
  readonly color = input.required<DotColor>();
  protected readonly cls = computed(() => DOT_CLASSES[this.color()]);
}
