import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,ArrowUpRight,BookOpen,CalendarDays,Check,ChevronDown,Download,Inbox,Menu,NotebookPen,Printer,Search,Sparkles,X} from 'lucide-react';
import {guideVersion,guideUpdated,guideSections,workflow,searchGuide,guideMarkdown} from './guide-content';
import {GuideDiagram} from './GuideDiagrams';
import './guide.css';

const workflowIcons={note:NotebookPen,inbox:Inbox,calendar:CalendarDays,check:Check};
function GuideBlock({block}){
 if(block.type==='paragraph')return <p>{block.text}</p>;
 if(block.type==='heading')return <h3>{block.text}</h3>;
 if(block.type==='steps')return <ol className="guide-steps">{block.items.map(([title,text],i)=><li key={title}><span aria-hidden="true">{String(i+1).padStart(2,'0')}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol>;
 if(block.type==='cards')return <div className="guide-cards">{block.items.map(([title,subtitle,text])=><div key={title}><h3>{title}</h3><strong>{subtitle}</strong><p>{text}</p></div>)}</div>;
 if(block.type==='table')return <div className="guide-table-wrap" tabIndex={0} role="region" aria-label={block.headers.join('、')+'对照表，可横向滚动'}><table><thead><tr>{block.headers.map(cell=><th scope="col" key={cell}>{cell}</th>)}</tr></thead><tbody>{block.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=>j===0?<th scope="row" key={j}>{cell}</th>:<td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
 if(block.type==='callout')return <aside className="guide-callout"><BookOpen size={19}/><div><strong>{block.title}</strong><p>{block.text}</p></div></aside>;
 if(block.type==='diagram')return <GuideDiagram {...block}/>;
 if(block.type==='faq')return <div className="guide-faq">{block.items.map(([question,answer])=><details key={question}><summary>{question}<ChevronDown size={17}/></summary><p>{answer}</p></details>)}</div>;
 return null;
}
function Workflow(){
 const [step,setStep]=useState(0),current=workflow[step],Icon=workflowIcons[current.icon];
 const tabs=useRef([]);
 function keydown(event,index){let next;if(event.key==='ArrowRight')next=(index+1)%workflow.length;else if(event.key==='ArrowLeft')next=(index+workflow.length-1)%workflow.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=workflow.length-1;else return;event.preventDefault();setStep(next);tabs.current[next]?.focus();}
 return <div className="guide-workflow"><div className="guide-workflow-heading"><span className="guide-small-label">HOW ME WORKS</span><span>点选一步，了解怎么做 <ArrowRight size={13}/></span></div><div className="guide-workflow-tabs" role="tablist" aria-label="从记录到行动" aria-orientation="horizontal">{workflow.map((item,i)=>{const ItemIcon=workflowIcons[item.icon];return <button key={item.title} ref={el=>{tabs.current[i]=el;}} id={'workflow-tab-'+i} role="tab" type="button" aria-selected={i===step} aria-controls="workflow-panel" tabIndex={i===step?0:-1} className={i===step?'is-active':''} onClick={()=>setStep(i)} onKeyDown={e=>keydown(e,i)}><span className="guide-workflow-icon"><ItemIcon size={22} strokeWidth={1.5}/></span><small>0{i+1}</small><strong>{item.title}</strong><span className="guide-workflow-short">{item.short}</span>{i<workflow.length-1&&<ArrowRight className="guide-workflow-arrow" size={16}/>}</button>;})}</div><div id="workflow-panel" role="tabpanel" aria-labelledby={'workflow-tab-'+step} tabIndex={0} className="guide-workflow-panel"><Icon size={24} strokeWidth={1.5}/><div><p>{current.body}</p><span>{current.example}</span></div></div><div className="guide-print-workflow">{workflow.map(item=><p key={item.title}><strong>{item.title}：</strong>{item.body}</p>)}</div></div>;
}
export default function Guide(){
 const [query,setQuery]=useState(''),[active,setActive]=useState('start'),[menu,setMenu]=useState(false),[searchOpen,setSearchOpen]=useState(false);
 const searchRef=useRef(null),menuButton=useRef(null),printDetails=useRef([]),results=searchGuide(query);
 useEffect(()=>{
  const oldTitle=document.title;document.title='使用指南 · Me';
  const sections=guideSections.map(s=>document.getElementById(s.id));
  let frame;
  const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const current=sections.filter(s=>s.getBoundingClientRect().top<=165).at(-1);setActive(current?.id||'start');});};
  window.addEventListener('scroll',update,{passive:true});update();
  const beforePrint=()=>{printDetails.current=[...document.querySelectorAll('.guide-faq details:not([open])')];printDetails.current.forEach(d=>{d.open=true;});};
  const afterPrint=()=>{printDetails.current.forEach(d=>{d.open=false;});printDetails.current=[];};
  window.addEventListener('beforeprint',beforePrint);window.addEventListener('afterprint',afterPrint);
  const timer=setTimeout(()=>{const target=sections.find(s=>'#'+s.id===location.hash);target?.scrollIntoView();},0);
  return()=>{document.title=oldTitle;clearTimeout(timer);cancelAnimationFrame(frame);window.removeEventListener('scroll',update);window.removeEventListener('beforeprint',beforePrint);window.removeEventListener('afterprint',afterPrint);};
 },[]);
 function navigate(){setMenu(false);setSearchOpen(false);setQuery('');}
 function download(){const blob=new Blob([guideMarkdown()],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='Me-使用指南.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function escape(event){if(event.key!=='Escape')return;if(searchOpen){setSearchOpen(false);searchRef.current?.focus();}else if(menu){setMenu(false);menuButton.current?.focus();}}
 return <div className="guide-page" onKeyDown={escape}>
  <a className="guide-skip" href="#guide-content">跳到文档正文</a>
  <header className="guide-header"><div className="guide-header-inner"><a href="/" className="brand" aria-label="Me 首页">me<span>.</span></a><span className="guide-header-divider"/><a href="/guide" className="guide-header-title">使用指南</a><div className="guide-header-actions"><button className="guide-utility" aria-label="下载文档" title="下载 Markdown 文档" onClick={download}><Download size={16}/><span>下载文档</span></button><button className="guide-utility" aria-label="打印或保存为 PDF" title="打印或保存为 PDF" onClick={()=>window.print()}><Printer size={16}/><span>打印 / PDF</span></button><a className="guide-return" href="/">我的空间 <ArrowUpRight size={15}/></a><button ref={menuButton} className="guide-menu-toggle" aria-label={menu?'关闭目录':'打开目录'} aria-expanded={menu} aria-controls="guide-sidebar" onClick={()=>setMenu(v=>!v)}>{menu?<X size={21}/>:<Menu size={21}/>}</button></div></div></header>
  <div className="guide-layout"><aside id="guide-sidebar" className={'guide-sidebar '+(menu?'is-open':'')} aria-label="文档工具与目录"><div className="guide-search"><Search size={16}/><input ref={searchRef} type="search" aria-label="搜索使用指南" placeholder="搜索使用指南…" value={query} aria-expanded={Boolean(query.trim()&&searchOpen)} aria-controls="guide-search-results" autoComplete="off" onFocus={()=>setSearchOpen(true)} onChange={e=>{setQuery(e.target.value);setSearchOpen(true);}}/>{query&&<button aria-label="清除文档搜索" onClick={()=>{setQuery('');searchRef.current?.focus();}}><X size={14}/></button>}</div>
   {query.trim()&&searchOpen&&<div id="guide-search-results" className="guide-search-results"><p role="status">{results.length?`找到 ${results.length} 个相关章节`:'没有找到相关内容'}</p>{results.map(section=><a href={'#'+section.id} key={section.id} onClick={navigate}><strong>{section.title}</strong><span>{section.summary}</span></a>)}{!results.length&&<span>试试「草稿」「验收」或「提醒」。</span>}</div>}
   <span className="guide-nav-label">在这份指南里</span><nav aria-label="使用指南目录">{guideSections.map((section,i)=><a href={'#'+section.id} key={section.id} className={active===section.id?'is-active':''} aria-current={active===section.id?'location':undefined} onClick={navigate}><span>{String(i+1).padStart(2,'0')}</span>{section.title}</a>)}</nav><div className="guide-sidebar-note"><span className="guide-sidebar-star" aria-hidden="true">✳</span><p>不必一次学会全部。<br/>从眼前的一件小事开始。</p><small>适用版本 {guideVersion}<br/>更新于 {guideUpdated}</small></div>
  </aside>
  <main id="guide-content" className="guide-main" tabIndex={-1}><section className="guide-hero" aria-labelledby="guide-title"><div className="guide-hero-kicker"><span/><span>A LITTLE GUIDE TO YOUR DAY</span></div><div className="guide-hero-title"><h1 id="guide-title">从一个念头，<br/>到有序的一天<span>。</span></h1><span className="guide-hero-flower" aria-hidden="true">✳</span></div><p>记录、安排、协作与回看。<br className="guide-mobile-break"/>这份指南，陪你把 Me 用得更顺手。</p><div className="guide-hero-meta"><span><BookOpen size={14}/>Me 使用指南</span><span>个人空间 & 组织协作</span><span>版本 {guideVersion}</span></div><Workflow/></section>
   <div className="guide-reading-paths"><a href="#start"><span>我是第一次来</span><strong>写下第一条记录 <ArrowRight size={17}/></strong></a><a href="#execution"><span>我想和团队协作</span><strong>了解交付与验收 <ArrowRight size={17}/></strong></a><a href="#faq"><span>我遇到了问题</span><strong>查找常见解答 <ArrowRight size={17}/></strong></a></div>
   {guideSections.map((section,i)=><section key={section.id} id={section.id} className="guide-section" aria-labelledby={section.id+'-title'}><header className="guide-section-heading"><span>{String(i+1).padStart(2,'0')}</span><div><h2 id={section.id+'-title'}>{section.title}<a href={'#'+section.id} aria-label={'链接到'+section.title}>#</a></h2><p>{section.summary}</p></div></header><div className="guide-prose">{section.blocks.map((block,j)=><GuideBlock block={block} key={j}/>)}</div></section>)}
   <div className="guide-closing"><Sparkles size={25} strokeWidth={1.3}/><h2>下一步，留给你的今天。</h2><p>不用安排好一切。先写下一件值得记住的事。</p><a href="/">进入我的空间 <ArrowRight size={16}/></a></div>
   <footer className="guide-footer"><span>me. 留一点空间，给自己。</span><a href="#guide-content"><ArrowLeft size={13}/>回到顶部</a><a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">京ICP备2026054579号</a></footer>
  </main></div>
 </div>;
}
