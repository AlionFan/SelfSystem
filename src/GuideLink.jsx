import React from 'react';
import {BookOpen} from 'lucide-react';

export function GuideLink({compact=false,section=''}){
 return <a className={'site-guide-link '+(compact?'topbar-guide icon-button':'')} href={'/guide'+(section?'#'+section:'')} target="_blank" rel="noopener noreferrer" aria-label="使用指南（在新标签页打开）" title="使用指南（在新标签页打开）"><BookOpen size={compact?18:17}/><span>使用指南</span></a>;
}
