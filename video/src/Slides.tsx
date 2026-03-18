import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from 'remotion';
import { COLORS } from './styles';

/* ===========================================
   SHARED COMPONENTS
   =========================================== */

const GridBg: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      backgroundImage: `
        linear-gradient(rgba(235,219,178,0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(235,219,178,0.03) 1px, transparent 1px)
      `,
      backgroundSize: '60px 60px',
    }}
  />
);

const SlideContainer: React.FC<{
  children: React.ReactNode;
  center?: boolean;
}> = ({ children, center }) => (
  <AbsoluteFill
    style={{
      backgroundColor: COLORS.bg,
      justifyContent: 'center',
      alignItems: center ? 'center' : 'flex-start',
      padding: 80,
    }}
  >
    <GridBg />
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        maxWidth: 1100,
        width: '100%',
        zIndex: 1,
        alignItems: center ? 'center' : 'flex-start',
        textAlign: center ? 'center' : 'left',
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

const FadeIn: React.FC<{
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame,
    fps,
    delay,
    config: { damping: 200 },
  });

  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${interpolate(progress, [0, 1], [30, 0])}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const Tag: React.FC<{ text: string; delay?: number }> = ({ text, delay = 0 }) => (
  <FadeIn delay={delay}>
    <span
      style={{
        fontFamily: 'JetBrains Mono',
        fontSize: 18,
        color: COLORS.blue,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
      }}
    >
      {text}
    </span>
  </FadeIn>
);

const Heading: React.FC<{ text: string; delay?: number; size?: number }> = ({
  text,
  delay = 5,
  size = 64,
}) => (
  <FadeIn delay={delay}>
    <h2
      style={{
        fontFamily: 'JetBrains Mono',
        fontSize: size,
        fontWeight: 700,
        color: COLORS.accent,
        lineHeight: 1.2,
        textShadow: `0 0 30px ${COLORS.accentGlow}`,
      }}
    >
      {text}
    </h2>
  </FadeIn>
);

const Card: React.FC<{
  children: React.ReactNode;
  delay?: number;
  borderColor?: string;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, borderColor, style }) => (
  <FadeIn delay={delay}>
    <div
      style={{
        background: COLORS.bgCard,
        border: `1px solid ${borderColor || COLORS.bgCardBorder}`,
        borderRadius: 8,
        padding: '18px 24px',
        ...style,
      }}
    >
      {children}
    </div>
  </FadeIn>
);

const Cursor: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame % 16,
    [0, 8, 16],
    [1, 0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return (
    <span style={{ opacity, color: COLORS.accent }}>&#9612;</span>
  );
};

/* ===========================================
   SLIDE 1: TITLE
   =========================================== */
export const Slide1Title: React.FC = () => {
  const frame = useCurrentFrame();

  const typingText = 'compressing Claude Code API traffic in real time...';
  const charIndex = Math.min(typingText.length, Math.floor(Math.max(0, frame - 60) / 1.5));
  const typed = typingText.slice(0, charIndex);

  return (
    <SlideContainer center>
      <FadeIn delay={0}>
        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 20, color: COLORS.textDim }}>
          <span style={{ color: COLORS.accent }}>$</span> curl -fsSL tamp.dev/setup.sh | bash
        </span>
      </FadeIn>
      <FadeIn delay={8}>
        <h1
          style={{
            fontFamily: 'JetBrains Mono',
            fontSize: 120,
            fontWeight: 700,
            color: COLORS.accent,
            lineHeight: 1,
            textShadow: `0 0 60px ${COLORS.accentGlow}`,
          }}
        >
          Tamp
        </h1>
      </FadeIn>
      <FadeIn delay={16}>
        <p style={{ fontSize: 32, color: COLORS.textDim }}>
          Compress the noise. Keep the signal.
        </p>
      </FadeIn>
      <Sequence from={60} layout="none" premountFor={30}>
        <div style={{ fontFamily: 'JetBrains Mono', fontSize: 18, color: COLORS.textDim, marginTop: 24 }}>
          {typed}<Cursor />
        </div>
      </Sequence>
      <FadeIn delay={50}>
        <span
          style={{
            fontFamily: 'JetBrains Mono',
            fontSize: 16,
            color: COLORS.blue,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginTop: 16,
          }}
        >
          Token compression proxy for Claude Code
        </span>
      </FadeIn>
    </SlideContainer>
  );
};

/* ===========================================
   SLIDE 2: THE PROBLEM
   =========================================== */
export const Slide2Problem: React.FC = () => (
  <SlideContainer>
    <Tag text="The Problem" />
    <Heading text="Tokens pile up. Fast." />
    <Card delay={15}>
      <p style={{ fontSize: 24, color: COLORS.text }}>
        <span style={{ color: COLORS.blue }}>Claude Code</span> sends full history every turn.
      </p>
    </Card>
    <Card delay={25}>
      <p style={{ fontSize: 24, color: COLORS.text }}>
        Tool results: <span style={{ color: COLORS.yellow }}>pretty JSON</span>, raw files, verbose CLI output.
      </p>
    </Card>
    <Card delay={35}>
      <p style={{ fontSize: 24, color: COLORS.text }}>
        <span style={{ color: COLORS.red }}>100K+ tokens</span> in minutes — mostly redundant.
      </p>
    </Card>
    <FadeIn delay={45}>
      <p style={{ fontSize: 20, color: COLORS.textDim, marginTop: 8 }}>
        More tokens = more cost, more latency, faster context exhaustion.
      </p>
    </FadeIn>
  </SlideContainer>
);

/* ===========================================
   SLIDE 3: THE SOLUTION
   =========================================== */
const PipelineStage: React.FC<{
  num: string;
  title: string;
  desc: string;
  delay: number;
}> = ({ num, title, desc, delay }) => (
  <FadeIn delay={delay}>
    <div
      style={{
        background: COLORS.bgCard,
        border: `1px solid ${COLORS.bgCardBorder}`,
        borderRadius: 8,
        padding: '20px 32px',
        textAlign: 'center',
        minWidth: 200,
      }}
    >
      <span style={{ fontFamily: 'JetBrains Mono', fontSize: 18, color: COLORS.blue }}>
        {num}
      </span>
      <p style={{ fontFamily: 'JetBrains Mono', fontSize: 22, color: COLORS.accent, fontWeight: 600, marginTop: 4 }}>
        {title}
      </p>
      <p style={{ fontSize: 16, color: COLORS.textDim, marginTop: 4 }}>{desc}</p>
    </div>
  </FadeIn>
);

const Arrow: React.FC<{ delay: number }> = ({ delay }) => (
  <FadeIn delay={delay}>
    <span style={{ fontFamily: 'JetBrains Mono', fontSize: 28, color: COLORS.accentDim }}>
      →
    </span>
  </FadeIn>
);

export const Slide3Solution: React.FC = () => (
  <SlideContainer center>
    <Tag text="The Solution" />
    <Heading text="3-Stage Pipeline" />
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 24 }}>
      <PipelineStage num="Stage 1" title="JSON Minify" desc="Strip whitespace" delay={15} />
      <Arrow delay={22} />
      <PipelineStage num="Stage 2" title="TOON Encode" desc="Columnar format" delay={25} />
      <Arrow delay={32} />
      <PipelineStage num="Stage 3" title="LLMLingua-2" desc="ML pruning" delay={35} />
    </div>
  </SlideContainer>
);

/* ===========================================
   SLIDE 4: JSON MINIFY
   =========================================== */
const CodeBlock: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      background: 'rgba(0, 0, 0, 0.4)',
      border: '1px solid rgba(235, 219, 178, 0.1)',
      borderRadius: 6,
      padding: '16px 20px',
      fontFamily: 'JetBrains Mono',
      fontSize: 16,
      lineHeight: 1.6,
      whiteSpace: 'pre',
      color: COLORS.text,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Slide4Minify: React.FC = () => (
  <SlideContainer>
    <Tag text="Stage 1" />
    <Heading text="JSON Minify" />
    <FadeIn delay={10}>
      <p style={{ fontSize: 22, color: COLORS.textDim }}>
        Strip whitespace. Instant, lossless.
      </p>
    </FadeIn>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8, width: '100%' }}>
      <FadeIn delay={20}>
        <div>
          <p style={{ fontFamily: 'JetBrains Mono', fontSize: 18, color: COLORS.red, marginBottom: 8 }}>Before</p>
          <CodeBlock>
            {`{\n  "name": "tamp",\n  "version": "0.1.0",\n  "type": "module",\n  "dependencies": {\n    "@toon-format/toon": "^2.1.0"\n  }\n}`}
          </CodeBlock>
        </div>
      </FadeIn>
      <FadeIn delay={30}>
        <div>
          <p style={{ fontFamily: 'JetBrains Mono', fontSize: 18, color: COLORS.green, marginBottom: 8 }}>After</p>
          <CodeBlock style={{ color: COLORS.green }}>
            {`{"name":"tamp","version":"0.1.0","type":"module","dependencies":{"@toon-format/toon":"^2.1.0"}}`}
          </CodeBlock>
        </div>
      </FadeIn>
    </div>
    <FadeIn delay={40} style={{ textAlign: 'center', width: '100%', marginTop: 8 }}>
      <span style={{ color: COLORS.textDim, fontSize: 20 }}>Typical saving: </span>
      <span style={{ color: COLORS.accent, fontFamily: 'JetBrains Mono', fontWeight: 700, fontSize: 24 }}>~30-50%</span>
    </FadeIn>
  </SlideContainer>
);

/* ===========================================
   SLIDE 5: TOON ENCODING
   =========================================== */
export const Slide5Toon: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const statProgress = spring({
    frame,
    fps,
    delay: 50,
    config: { damping: 200 },
  });

  const statValue = Math.round(interpolate(statProgress, [0, 1], [0, 50.6]));

  return (
    <SlideContainer>
      <Tag text="Stage 2" />
      <Heading text="TOON Encoding" />
      <FadeIn delay={10}>
        <p style={{ fontSize: 22, color: COLORS.textDim }}>
          Array-of-objects → columnar. Huge wins on tabular data.
        </p>
      </FadeIn>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8, width: '100%' }}>
        <FadeIn delay={20}>
          <div>
            <p style={{ fontFamily: 'JetBrains Mono', fontSize: 18, color: COLORS.red, marginBottom: 8 }}>
              JSON (334 chars)
            </p>
            <CodeBlock>
              {`[{"name":"a.js","size":1024},\n {"name":"b.js","size":2048},\n {"name":"c.js","size":512}]`}
            </CodeBlock>
          </div>
        </FadeIn>
        <FadeIn delay={30}>
          <div>
            <p style={{ fontFamily: 'JetBrains Mono', fontSize: 18, color: COLORS.green, marginBottom: 8 }}>
              TOON (165 chars)
            </p>
            <CodeBlock style={{ color: COLORS.green }}>
              {`name[3]{a.js|b.js|c.js}\nsize[3]{1024|2048|512}`}
            </CodeBlock>
          </div>
        </FadeIn>
      </div>
      <FadeIn delay={45} style={{ textAlign: 'center', width: '100%', marginTop: 16 }}>
        <span
          style={{
            fontFamily: 'JetBrains Mono',
            fontSize: 72,
            fontWeight: 700,
            color: COLORS.accent,
            textShadow: `0 0 60px ${COLORS.accentGlow}`,
          }}
        >
          -{statValue}%
        </span>
        <p style={{ fontSize: 18, color: COLORS.textDim }}>on real package.json tool result</p>
      </FadeIn>
    </SlideContainer>
  );
};

/* ===========================================
   SLIDE 6: LLMLINGUA
   =========================================== */
const StatCard: React.FC<{
  label: string;
  before: string;
  after: string;
  pct: string;
  delay: number;
}> = ({ label, before, after, pct, delay }) => (
  <Card delay={delay} style={{ width: '100%' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <p style={{ fontSize: 18, color: COLORS.textDim }}>{label}</p>
        <p style={{ fontFamily: 'JetBrains Mono', fontSize: 22 }}>
          <span style={{ color: COLORS.red }}>{before}</span>
          {' → '}
          <span style={{ color: COLORS.green }}>{after}</span>
          {' chars'}
        </p>
      </div>
      <span
        style={{
          fontFamily: 'JetBrains Mono',
          fontSize: 48,
          fontWeight: 700,
          color: COLORS.accent,
          textShadow: `0 0 40px ${COLORS.accentGlow}`,
        }}
      >
        {pct}
      </span>
    </div>
  </Card>
);

export const Slide6LLMLingua: React.FC = () => (
  <SlideContainer>
    <Tag text="Stage 3" />
    <Heading text="LLMLingua-2" />
    <FadeIn delay={10}>
      <p style={{ fontSize: 22, color: COLORS.textDim }}>
        ML token pruning. Preserves meaning, drops the rest.
      </p>
    </FadeIn>
    <StatCard label="compress.js source code" before="4,630" after="2,214" pct="-52.2%" delay={20} />
    <StatCard label="ls -la command output" before="1,046" after="516" pct="-50.7%" delay={30} />
    <FadeIn delay={45}>
      <p style={{ fontSize: 18, color: COLORS.textDim, textAlign: 'center', width: '100%' }}>
        Python sidecar · Microsoft LLMLingua-2 · CPU
      </p>
    </FadeIn>
  </SlideContainer>
);

/* ===========================================
   SLIDE 7: LIVE RESULTS
   =========================================== */
const LogEntry: React.FC<{
  label: string;
  method: string;
  before: string;
  after: string;
  pct: string;
  delay: number;
}> = ({ label, method, before, after, pct, delay }) => (
  <FadeIn delay={delay}>
    <div
      style={{
        background: 'rgba(0, 0, 0, 0.4)',
        borderLeft: `3px solid ${COLORS.accent}`,
        padding: '12px 18px',
        fontFamily: 'JetBrains Mono',
        fontSize: 18,
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: COLORS.blue }}>{label}</span>
      {' — '}
      <span style={{ color: COLORS.textDim }}>{method}</span>
      <br />
      {before} → {after} chars{' '}
      <span style={{ color: COLORS.accent, fontWeight: 700 }}>({pct})</span>
    </div>
  </FadeIn>
);

export const Slide7Results: React.FC = () => (
  <SlideContainer>
    <Tag text="Live Results" />
    <Heading text="Real proxy session" />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', marginTop: 8 }}>
      <LogEntry label="Read package.json" method="json → toon" before="334" after="165" pct="-50.6%" delay={15} />
      <LogEntry label="Read compress.js" method="text → llmlingua" before="4,630" after="2,214" pct="-52.2%" delay={25} />
      <LogEntry label="Bash ls -la" method="text → llmlingua" before="1,046" after="516" pct="-50.7%" delay={35} />
    </div>
    <Card delay={50} borderColor={COLORS.accent} style={{ width: '100%', textAlign: 'center' }}>
      <p style={{ fontFamily: 'JetBrains Mono', fontSize: 24 }}>
        Session total:{' '}
        <span style={{ color: COLORS.accent, fontWeight: 700 }}>3,115 chars saved</span>
      </p>
    </Card>
  </SlideContainer>
);

/* ===========================================
   SLIDE 8: ARCHITECTURE
   =========================================== */
const FlowBox: React.FC<{
  text: string;
  highlight?: boolean;
  delay: number;
}> = ({ text, highlight, delay }) => (
  <FadeIn delay={delay}>
    <div
      style={{
        border: `1px solid ${highlight ? COLORS.accent : COLORS.bgCardBorder}`,
        borderRadius: 6,
        padding: '12px 24px',
        fontFamily: 'JetBrains Mono',
        fontSize: 20,
        textAlign: 'center',
        color: highlight ? COLORS.accent : COLORS.text,
        background: highlight ? COLORS.bgCard : 'transparent',
      }}
    >
      {text}
    </div>
  </FadeIn>
);

export const Slide8Architecture: React.FC = () => (
  <SlideContainer center>
    <Tag text="Architecture" />
    <Heading text="Transparent HTTP Proxy" />
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 24 }}>
      <FlowBox text="Claude Code" delay={15} />
      <Arrow delay={20} />
      <FlowBox text="tamp:7778" highlight delay={22} />
      <Arrow delay={28} />
      <FlowBox text="Anthropic API" delay={30} />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 32, maxWidth: 800, width: '100%' }}>
      <Card delay={35}>
        <p style={{ fontFamily: 'JetBrains Mono', fontSize: 16, color: COLORS.blue, marginBottom: 4 }}>Intercept</p>
        <p style={{ fontSize: 16, color: COLORS.textDim }}>POST /v1/messages only. All other routes pass through.</p>
      </Card>
      <Card delay={40}>
        <p style={{ fontFamily: 'JetBrains Mono', fontSize: 16, color: COLORS.blue, marginBottom: 4 }}>Compress</p>
        <p style={{ fontSize: 16, color: COLORS.textDim }}>tool_result blocks compressed per content type.</p>
      </Card>
      <Card delay={45}>
        <p style={{ fontFamily: 'JetBrains Mono', fontSize: 16, color: COLORS.blue, marginBottom: 4 }}>Forward</p>
        <p style={{ fontSize: 16, color: COLORS.textDim }}>Rewrite Content-Length, stream response back.</p>
      </Card>
      <Card delay={50}>
        <p style={{ fontFamily: 'JetBrains Mono', fontSize: 16, color: COLORS.blue, marginBottom: 4 }}>Safety</p>
        <p style={{ fontSize: 16, color: COLORS.textDim }}>256KB+ bypass. Parse errors fall through.</p>
      </Card>
    </div>
  </SlideContainer>
);

/* ===========================================
   SLIDE 9: USAGE
   =========================================== */
export const Slide9Usage: React.FC = () => {
  const frame = useCurrentFrame();

  const line1 = '$ curl -fsSL tamp.dev/setup.sh | bash';
  const line2 = '✓ Done! Restart your shell, then:';
  const line3 = '$ tamp';
  const line4 = '$ claude';

  const speed = 1.5;
  const l1Start = 30;
  const l1End = l1Start + line1.length * speed;
  const l2Start = l1End + 10;
  const l3Start = l2Start + 30;
  const l3End = l3Start + line3.length * speed;
  const l4Start = l3End + 15;

  const getTyped = (text: string, start: number) => {
    const elapsed = frame - start;
    if (elapsed < 0) return '';
    return text.slice(0, Math.min(text.length, Math.floor(elapsed / speed)));
  };

  return (
    <SlideContainer center>
      <Tag text="Setup" />
      <Heading text="One command" />
      <FadeIn delay={10} style={{ width: '100%', maxWidth: 800 }}>
        <CodeBlock style={{ fontSize: 18, lineHeight: 1.8, textAlign: 'left' }}>
          <span style={{ color: COLORS.accent }}>{getTyped(line1, l1Start)}</span>
          {frame >= l1Start && <Cursor />}
          {frame >= l2Start && (
            <>
              {'\n\n'}
              <span style={{ color: COLORS.aqua }}>{getTyped(line2, l2Start)}</span>
            </>
          )}
          {frame >= l3Start && (
            <>
              {'\n\n'}
              <span style={{ color: COLORS.accent }}>{getTyped(line3, l3Start)}</span>
              {frame < l4Start && <Cursor />}
            </>
          )}
          {frame >= l4Start && (
            <>
              {'\n'}
              <span style={{ color: COLORS.accent }}>{getTyped(line4, l4Start)}</span>
              <Cursor />
            </>
          )}
        </CodeBlock>
      </FadeIn>
      <FadeIn delay={50}>
        <p style={{ fontSize: 22, color: COLORS.textDim, marginTop: 16 }}>
          Installs to ~/.tamp, configures your shell. That's it.
        </p>
      </FadeIn>
    </SlideContainer>
  );
};

/* ===========================================
   SLIDE 10: WHAT'S NEXT
   =========================================== */
export const Slide10Next: React.FC = () => {
  const items = [
    'Extended thinking block compression',
    'Response caching for repeated tool calls',
    'Per-session dashboards with live stats',
    'Configurable compression aggressiveness',
  ];

  return (
    <SlideContainer center>
      <Tag text="Roadmap" />
      <Heading text="What's Next" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16, maxWidth: 600, width: '100%' }}>
        {items.map((item, i) => (
          <FadeIn key={i} delay={15 + i * 8}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: COLORS.accent,
                  boxShadow: `0 0 8px ${COLORS.accentGlow}`,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 22, color: COLORS.text }}>{item}</span>
            </div>
          </FadeIn>
        ))}
      </div>
      <FadeIn delay={60} style={{ marginTop: 40, textAlign: 'center' }}>
        <h1
          style={{
            fontFamily: 'JetBrains Mono',
            fontSize: 64,
            fontWeight: 700,
            color: COLORS.accent,
            textShadow: `0 0 60px ${COLORS.accentGlow}`,
          }}
        >
          Tamp
        </h1>
        <p style={{ fontSize: 24, color: COLORS.textDim, marginTop: 8 }}>
          Compress the noise. Keep the signal.
        </p>
      </FadeIn>
    </SlideContainer>
  );
};
