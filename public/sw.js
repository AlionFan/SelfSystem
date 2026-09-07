const CACHE='me-shell-v7-productivity';
self.addEventListener('install',event=>{event.waitUntil((async()=>{
  const cache=await caches.open(CACHE),response=await fetch('/');
  if(!response.ok)throw new Error('Device authorization required');
  const html=await response.clone().text();
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^"<>]+)"/g)].map(match=>match[1]);
  await cache.put('/',response);
  await cache.addAll([...new Set(['/icon.svg','/manifest.webmanifest','/icon-192.png',...assets])]);
  await self.skipWaiting();
})());});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('me-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||event.request.method!=='GET'||url.pathname.startsWith('/api/')||url.pathname==='/healthz')return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok&&(event.request.mode==='navigate'||url.pathname.startsWith('/assets/')||url.pathname.startsWith('/icon'))){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}
    return response;
  }).catch(async()=>{const cache=await caches.open(CACHE);return await cache.match(event.request)||(event.request.mode==='navigate'?await cache.match('/'):null)||new Response('暂时离线，请联网后重试',{status:503});}));
});
self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()??{};}catch{}
  let url='/';try{const candidate=new URL(data.url,self.location.origin);if(candidate.origin===self.location.origin)url=candidate.href;}catch{}
  event.waitUntil(self.registration.showNotification(data.title||'Me · 提醒',{body:data.body||'你有一项待办提醒',icon:'/icon-192.png',badge:'/icon-192.png',tag:data.tag||'me-reminder',data:{url}}));
});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{const client=clients[0];if(client){await client.navigate(event.notification.data?.url||'/');return client.focus();}return self.clients.openWindow(event.notification.data?.url||'/');}));});
