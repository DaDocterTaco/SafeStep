import { useRef, type ReactNode } from 'react';
export const areas = ['Guide', 'Safety checks', 'Shopping', 'Settings'] as const;
export type Area = (typeof areas)[number];
const areaId = (area: Area) => area.toLowerCase().replace(' ', '-');
export function Areas({ current, select }: { current: Area; select: (next: Area) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <nav className="areas" role="tablist" aria-label="SafeStep areas">
      {areas.map((area, index) => (
        <button
          key={area}
          id={'tab-' + areaId(area)}
          role="tab"
          type="button"
          ref={(n) => {
            refs.current[index] = n;
          }}
          aria-selected={area === current}
          tabIndex={area === current ? 0 : -1}
          aria-controls={'area-' + areaId(area)}
          onClick={() => select(area)}
          onKeyDown={(e) => {
            let next = index;
            if (e.key === 'ArrowRight') next = (index + 1) % areas.length;
            else if (e.key === 'ArrowLeft') next = (index + areas.length - 1) % areas.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = areas.length - 1;
            else return;
            e.preventDefault();
            select(areas[next]!);
            refs.current[next]?.focus();
          }}
        >
          {area}
        </button>
      ))}
    </nav>
  );
}
export function AreaPane({
  name,
  current,
  children,
}: {
  name: Area;
  current: Area;
  children: ReactNode;
}) {
  return (
    <div
      className="area-panel"
      role="tabpanel"
      hidden={name !== current}
      id={'area-' + areaId(name)}
      aria-labelledby={'tab-' + areaId(name)}
    >
      {children}
    </div>
  );
}
