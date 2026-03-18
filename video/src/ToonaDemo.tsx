import React from 'react';
import { loadFont } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { SLIDE_DURATION, TRANSITION_FRAMES } from './styles';
import {
  Slide1Title,
  Slide2Problem,
  Slide3Solution,
  Slide4Minify,
  Slide5Toon,
  Slide6LLMLingua,
  Slide7Results,
  Slide8Architecture,
  Slide9Usage,
  Slide10Next,
} from './Slides';

loadFont('normal', { weights: ['400', '700'], subsets: ['latin'] });
loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });

const slides = [
  Slide1Title,
  Slide2Problem,
  Slide3Solution,
  Slide4Minify,
  Slide5Toon,
  Slide6LLMLingua,
  Slide7Results,
  Slide8Architecture,
  Slide9Usage,
  Slide10Next,
];

export const ToonaDemo: React.FC = () => {
  const timing = linearTiming({ durationInFrames: TRANSITION_FRAMES });

  return (
    <TransitionSeries>
      {slides.map((SlideComponent, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <TransitionSeries.Transition
              presentation={fade()}
              timing={timing}
            />
          )}
          <TransitionSeries.Sequence durationInFrames={SLIDE_DURATION}>
            <SlideComponent />
          </TransitionSeries.Sequence>
        </React.Fragment>
      ))}
    </TransitionSeries>
  );
};
