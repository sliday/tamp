import React from 'react';
import { Composition } from 'remotion';
import { ToonaDemo } from './ToonaDemo';
import { TOTAL_FRAMES, FPS } from './styles';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Root"
      component={ToonaDemo}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
