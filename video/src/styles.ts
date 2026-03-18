export const COLORS = {
  bg: '#282828',
  bgCard: 'rgba(235, 219, 178, 0.05)',
  bgCardBorder: 'rgba(235, 219, 178, 0.15)',
  accent: '#d79921',
  accentDim: 'rgba(215, 153, 33, 0.6)',
  accentGlow: 'rgba(215, 153, 33, 0.25)',
  blue: '#83a598',
  blueDim: 'rgba(131, 165, 152, 0.6)',
  text: '#ebdbb2',
  textDim: '#a89984',
  red: '#fb4934',
  yellow: '#fabd2f',
  green: '#b8bb26',
  aqua: '#8ec07c',
} as const;

export const FPS = 30;
export const SLIDE_DURATION = 180; // 6 seconds per slide
export const TOTAL_SLIDES = 10;
export const TRANSITION_FRAMES = 15;

export const TOTAL_FRAMES = TOTAL_SLIDES * SLIDE_DURATION - (TOTAL_SLIDES - 1) * TRANSITION_FRAMES;
