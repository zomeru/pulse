// Small inline icon set. No icon dependency: these are 20 lines each, inherit
// `currentColor`, and are all we need for the whole product.

type IconProps = {
  className?: string;
};

function svg(path: React.ReactNode, viewBox = "0 0 24 24") {
  return function Icon({ className }: IconProps) {
    return (
      <svg
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className ?? "h-5 w-5"}
      >
        {path}
      </svg>
    );
  };
}

export const SendIcon = svg(
  <>
    <path d="M4.6 12h13.2" />
    <path d="m12.4 6.2 5.8 5.8-5.8 5.8" />
  </>,
);

export const VideoIcon = svg(
  <>
    <rect x="2.8" y="6.4" width="12.4" height="11.2" rx="3" />
    <path d="m15.2 11 5-2.9v7.8l-5-2.9z" />
  </>,
);

export const PhoneOffIcon = svg(
  <>
    <path d="M5.4 4.1c-1.6.6-2.6 1.9-2.4 3.4.6 4.6 2.9 8.7 6.4 11.4 2.5 2 5.3 3.1 8 3.2 1.2 0 2.2-.8 2.4-1.9l.3-1.9c.1-.7-.3-1.3-1-1.6l-3.1-1.3c-.6-.3-1.3-.1-1.7.5l-1 1.4a13 13 0 0 1-5.2-5.2l1.4-1c.6-.4.8-1.1.5-1.7L8.1 5c-.3-.7-.9-1.1-1.6-1z" />
    <path d="m3.5 3.5 17 17" />
  </>,
);

export const MicIcon = svg(
  <>
    <rect x="9" y="2.8" width="6" height="11" rx="3" />
    <path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0" />
    <path d="M12 17.8V21" />
  </>,
);

export const MicOffIcon = svg(
  <>
    <path d="M15 5.6A3 3 0 0 0 9 5.9v4.4" />
    <path d="M9 14.2a3 3 0 0 0 5.4 1.2" />
    <path d="M5.6 11.4a6.4 6.4 0 0 0 9.9 5.3" />
    <path d="M18.4 11.4v.4" />
    <path d="M12 17.8V21" />
    <path d="m3.5 3.5 17 17" />
  </>,
);

export const CameraIcon = svg(
  <>
    <rect x="2.8" y="6.4" width="12.4" height="11.2" rx="3" />
    <path d="m15.2 11 5-2.9v7.8l-5-2.9z" />
  </>,
);

export const CameraOffIcon = svg(
  <>
    <path d="M15.2 8.4V9.4a3 3 0 0 1-3 3H9" />
    <path d="M5.2 7.2A3 3 0 0 0 2.8 9.4v5.2a3 3 0 0 0 3 3h7.4a3 3 0 0 0 2.2-1" />
    <path d="m15.2 11 5-2.9v7.8l-2-1.2" />
    <path d="m3.5 3.5 17 17" />
  </>,
);

export const LockIcon = svg(
  <>
    <rect x="4.8" y="10.4" width="14.4" height="9.6" rx="3" />
    <path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6" />
  </>,
);

export const CloseIcon = svg(
  <>
    <path d="m6.5 6.5 11 11" />
    <path d="m17.5 6.5-11 11" />
  </>,
);

export const ChevronDownIcon = svg(<path d="m6 9.5 6 6 6-6" />);

export const CheckIcon = svg(<path d="m5 12.8 4.4 4.2L19 7.4" />);

export const CrosshairIcon = svg(
  <>
    <circle cx="12" cy="12" r="7.2" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M12 1.8v3.2M12 19v3.2M22.2 12H19M5 12H1.8" />
  </>,
);

export const CompassIcon = svg(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m14.9 9.1-1.6 4.2-4.2 1.6 1.6-4.2z" />
  </>,
);

export const RefreshIcon = svg(
  <>
    <path d="M20.2 12a8.2 8.2 0 1 1-2.6-6" />
    <path d="M20.4 4.4V10h-5.6" />
  </>,
);

export const AlertIcon = svg(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.8v4.6" />
    <path d="M12 16.1h.01" strokeWidth={2.2} />
  </>,
);

export const WaveIcon = svg(
  <>
    <path d="M3 12h2.6l2-4.6 2.8 9.2 2.4-6.6 1.8 4H21" />
  </>,
);
