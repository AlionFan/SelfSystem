import {Resvg} from '@resvg/resvg-js';
import {readFileSync,writeFileSync} from 'node:fs';
for(const size of [192,512])writeFileSync(`public/icon-${size}.png`,new Resvg(readFileSync('public/icon.svg'),{fitTo:{mode:'width',value:size}}).render().asPng());
