const PATHS = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  skip: 'M6 5.5v13l9-6.5zM16 5h2.5v14H16z',
  restart: 'M12 5a7 7 0 1 1-6.6 4.7l1.9.6A5 5 0 1 0 12 7v3L7.5 6 12 2z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  up: 'M12 7l6 7H6z',
  down: 'M12 17l6-7H6z',
  top: 'M6 5h12v2H6zM12 9l6 7H6z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z',
  check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z',
  search:
    'M10.5 4a6.5 6.5 0 0 1 5.2 10.4l4 4-1.4 1.4-4-4A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  gear: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm-1.2-5.5h2.4l.5 2.4 1.5.6 2-1.3 1.7 1.7-1.3 2 .6 1.5 2.4.5v2.4l-2.4.5-.6 1.5 1.3 2-1.7 1.7-2-1.3-1.5.6-.5 2.4h-2.4l-.5-2.4-1.5-.6-2 1.3-1.7-1.7 1.3-2-.6-1.5-2.4-.5v-2.4l2.4-.5.6-1.5-1.3-2 1.7-1.7 2 1.3 1.5-.6z',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zm-6 8h2a4 4 0 0 0 8 0h2a6 6 0 0 1-5 5.9V20h3v2H8v-2h3v-3.1A6 6 0 0 1 6 11z',
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15 8.5a5 5 0 0 1 0 7l-1.2-1.3a3.2 3.2 0 0 0 0-4.4z',
  full: 'M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z',
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
