import type { FalloffMode } from '@magnet/shared/sim/magnet';
import { TUNABLES, TUNABLE_SPECS, type Tunables } from '@magnet/shared/sim/tunables';

/**
 * Live tuning panel. Writes straight into TUNABLES, which the sim re-reads
 * every tick, so the force curve can be felt while it changes.
 */
export function mountTuner(root: HTMLElement): void {
  const defaults: Tunables = { ...TUNABLES };
  const groups = new Map<string, HTMLElement>();

  for (const spec of TUNABLE_SPECS) {
    let group = groups.get(spec.group);
    if (!group) {
      group = document.createElement('div');
      group.className = 'tuner-group';
      const title = document.createElement('h3');
      title.textContent = spec.group;
      group.appendChild(title);
      root.appendChild(group);
      groups.set(spec.group, group);
    }

    const row = document.createElement('label');
    row.className = 'tuner-row';

    const name = document.createElement('span');
    name.className = 'tuner-name';
    name.textContent = spec.label;

    const value = document.createElement('span');
    value.className = 'tuner-value';

    if (spec.kind === 'select') {
      const select = document.createElement('select');
      for (const option of spec.options) {
        const el = document.createElement('option');
        el.value = option;
        el.textContent = option;
        select.appendChild(el);
      }
      select.value = String(TUNABLES[spec.key]);
      select.addEventListener('change', () => {
        (TUNABLES as unknown as Record<string, unknown>)[spec.key] = select.value as FalloffMode;
      });
      row.append(name, select);
    } else {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(TUNABLES[spec.key]);
      value.textContent = input.value;
      input.addEventListener('input', () => {
        const parsed = Number(input.value);
        (TUNABLES as unknown as Record<string, number>)[spec.key] = parsed;
        value.textContent = input.value;
      });
      row.append(name, input, value);
    }

    group.appendChild(row);
  }

  const reset = document.createElement('button');
  reset.className = 'tuner-reset';
  reset.textContent = 'Reset tunables';
  reset.addEventListener('click', () => {
    Object.assign(TUNABLES, defaults);
    // Cheapest correct way to resync every control to the restored values.
    root.replaceChildren();
    mountTuner(root);
  });
  root.appendChild(reset);
}
