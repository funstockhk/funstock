(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var NEUTRAL='密码不正确或链接已失效。如有疑问，请联系负责顾问。';
var b64=function(s){var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
var fails=0,timer=null;

function showErr(m){var e=$('err');e.textContent=m;e.classList.remove('hidden')}
async function decrypt(pw){
  var r=await fetch('data.enc.json',{cache:'no-store',credentials:'omit'});
  if(!r.ok) throw new Error('nf');
  var p=await r.json();
  if(p.kdf!=='PBKDF2-SHA256'||p.alg!=='AES-256-GCM'||!(p.iter>=600000)) throw new Error('fmt');
  var enc=new TextEncoder();
  var base=await crypto.subtle.importKey('raw',enc.encode(pw),'PBKDF2',false,['deriveKey']);
  var key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:b64(p.salt),iterations:p.iter},base,{name:'AES-GCM',length:256},false,['decrypt']);
  var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(p.iv),additionalData:enc.encode(p.aad),tagLength:128},key,b64(p.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

$('f').addEventListener('submit',async function(ev){
  ev.preventDefault();
  var pw=$('pw').value; if(!pw) return;
  var btn=$('go'); btn.disabled=true; btn.textContent='正在解锁…'; $('err').classList.add('hidden');
  try{
    if(!window.crypto||!crypto.subtle) throw new Error('nocrypto');
    var d=await decrypt(pw);
    $('pw').value=''; pw=null;
    render(d);
  }catch(e){
    fails++;
    $('pw').value='';
    showErr(e&&e.message==='nocrypto'?'当前浏览器不支持安全解密，请改用最新版浏览器打开。':NEUTRAL);
    var wait=Math.min(30,fails>2?(fails-2)*5:0);
    if(wait){btn.textContent='请稍候 '+wait+' 秒';await new Promise(function(r){setTimeout(r,wait*1000)})}
  }finally{btn.disabled=false;btn.textContent='查看看板'}
});

/* ---------- helpers ---------- */
function daysTo(dateStr){ // whole days from today (HK date) to target date
  var now=new Date(), hk=new Date(now.getTime()+8*36e5);
  var today=Date.UTC(hk.getUTCFullYear(),hk.getUTCMonth(),hk.getUTCDate());
  var p=dateStr.split('-'); var t=Date.UTC(+p[0],+p[1]-1,+p[2]);
  return Math.round((t-today)/864e5);
}
function addDays(dateStr,n){var p=dateStr.split('-');var t=new Date(Date.UTC(+p[0],+p[1]-1,+p[2]+n));return t.toISOString().slice(0,10)}
function cd(target){
  var ms=new Date(target+'T00:00:00+08:00')-Date.now(); if(ms<=0) return '已到期';
  var d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);
  var z=function(x){return String(x).padStart(2,'0')};
  return d+' 天 '+z(h)+':'+z(m)+':'+z(s);
}
var kv=function(k,v){return '<div class="kv"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v||'—')+'</div></div>'};
var ST_CLASS={'已齐':'done','已收到·核对中':'reviewing','待提交':'pending','请按说明补交':'fix'};

function table(items,att){
  var stats={};items.forEach(function(i){stats[i[1]]=(stats[i[1]]||0)+1});
  var chips=Object.keys(stats).map(function(k){return '<span>'+esc(k)+' '+stats[k]+'</span>'}).join('');
  var rows=items.map(function(i){
    var a=(att&&att[i[0]])||[];
    return '<tr><td data-l="资料项">'+esc(i[0])+'</td><td data-l="状态" class="st st-'+(ST_CLASS[i[1]]||'other')+'">'+esc(i[1])+'</td><td data-l="需补说明">'+(esc(i[2])||'—')+'</td><td data-l="已上传">'+(a.length?a.map(esc).join('<br>'):'—')+'</td></tr>';
  }).join('');
  return '<div class="chips">'+chips+'</div><table><thead><tr><th>资料项</th><th>状态</th><th>需补说明</th><th>已上传</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

/* ---------- boards ---------- */
function renewal(r,upd){
  if(!r) return '';
  var cat=[r['身份类型'],r['类别']].filter(Boolean).join(' · ');
  var diag=(r['诊断']||[]).map(function(x){return '<div class="diag card"><h2>'+esc(x['服务线'])+'（'+esc(x['诊断周期'])+'）</h2><p><b>现状：</b>'+esc(x['现状'])+'</p><p><b>缺口：</b>'+esc(x['缺口'])+'</p><p><b>建议动作：</b>'+esc(x['建议动作'])+'</p><p class="muted">负责方：'+esc(x['负责方'])+'　下次复检：'+esc(x['下次复检日']||'—')+'</p></div>'}).join('');
  var prog=r['进度']||{};
  return '<section class="sec" id="s-renew"><div class="sec-title"><h2>续签进度看板</h2><span>已签约客户 · 资料进度</span></div>'+
  '<section class="card"><div class="grid">'+kv('客户代号',r['客户代号'])+kv('身份类别',cat)+kv('服务档位',r['服务档位'])+kv('项目阶段',r['项目阶段'])+'</div></section>'+
  '<section class="card count"><div class="grid"><div class="kv"><div class="k lt">距逗留期限届满（'+esc(r['逗留期限'])+'）</div><div class="big" id="cd">—</div></div>'+
  ['续签窗口开日','最迟递交参考日'].map(function(k){var v=r[k];var n=v?daysTo(v):null;return '<div class="kv"><div class="k lt">'+k+'</div><div class="v">'+esc(v||'—')+(n!==null?'<span class="lt" style="font-weight:400;font-size:.85rem">　'+(n>0?'还有 '+n+' 天':(n===0?'今天':'已过 '+(-n)+' 天'))+'</span>':'')+'</div></div>'}).join('')+
  '</div></section>'+
  '<section class="card"><div class="grid"><div class="kv"><div class="k muted">个人资料进度</div><div class="v prog">'+esc(prog['个人']||'—')+'</div></div><div class="kv"><div class="k muted">公司资料进度</div><div class="v prog">'+esc(prog['公司']||'—')+'</div></div></div></section>'+
  '<section class="card"><h2>个人资料</h2>'+table(r['个人资料']||[],r['附件示例'])+'</section>'+
  '<section class="card"><h2>公司资料</h2>'+table(r['公司资料']||[],r['附件示例'])+'</section>'+
  (diag?'<h2>顾问诊断</h2>'+diag:'')+
  '<p class="muted supply-hint">如需补交资料，请按顾问约定渠道提交。本看板暂不开放上传。</p>'+
  '<p class="muted">数据更新：'+esc(upd)+'（香港时间）</p></section>';
}

function diagnosis(g){
  if(!g) return '';
  var until=addDays(g['初诊日期'],g['有效天数']||14), left=daysTo(until), node=g['参考节点'], nd=node?daysTo(node):null;
  return '<section class="sec" id="s-diag"><div class="sec-title"><h2>初步诊断 · 资料规划参考</h2><span>潜在客户 · 初诊</span></div>'+
  '<div><span class="tag">初诊阶段</span><span class="disclaimer">· 非正式签证倒计时 · 仅供规划参考 · 不构成审批结果</span></div>'+
  '<p class="muted" style="margin:8px 0 12px">初诊日期 '+esc(g['初诊日期'])+' · 初诊有效期 '+esc(g['有效天数'])+' 天（至 '+esc(until)+'，'+(left>=0?'还剩 '+left+' 天':'已过期')+'）</p>'+
  (node?'<div class="node"><b>建议启动正式筹备的参考节点：</b>'+esc(node)+'　<span class="d">'+(nd>0?'约 '+nd+' 天后':(nd===0?'今天':'已过 '+(-nd)+' 天'))+'</span><div class="note">此为规划参考节点，非签证期限。</div></div>':'')+
  '<div class="grid3">'+
  '<section class="dcard"><div class="hd">1. 资料有无自报</div><div class="bd"><p style="margin:0 0 8px;color:#6b6f7a">以下为资料情况自报，仅供诊断参考，非正式材料审核。</p>'+
    (g['自报']||[]).map(function(x){return '<div class="row"><span>'+esc(x[0])+'</span><span class="pill '+(x[1]==='有'?'pill-y':'pill-n')+'">'+esc(x[1])+'</span></div>'}).join('')+
    '<p class="note">※ 此为自报情况，非正式文件提交。</p></div></section>'+
  '<section class="dcard"><div class="hd">2. 缺失项目诊断</div><div class="bd"><p style="margin:0 0 8px;color:#6b6f7a">根据自报情况，诊断出以下缺失项目及说明。</p>'+
    (g['缺失']||[]).map(function(x){return '<div class="box"><b>'+esc(x['项'])+'</b>事实：'+esc(x['事实'])+'<br>建议：'+esc(x['建议'])+'</div>'}).join('')+
    '<p class="note">※ 以上为初诊判断，仅供规划参考，不作为最终结论。</p></div></section>'+
  '<section class="dcard"><div class="hd">3. 上传限额</div><div class="bd center"><div>已用上传次数</div><div class="big">'+esc(g['上传已用'])+' / '+esc(g['上传上限'])+' 次</div><div style="color:#6b6f7a">如需补充说明，请按顾问约定渠道提供。</div></div></section>'+
  '</div>'+
  '<section class="summary"><div><h3>初诊摘要（已发布）</h3><ul>'+(g['摘要']||[]).map(function(s){return '<li>'+esc(s)+'</li>'}).join('')+'</ul></div><div class="ok">✓ 顾问已发布 · 仅一版</div></section>'+
  '<p class="muted" style="margin-top:10px">后续服务说明由顾问另行联系。</p></section>';
}

var TIER={
  R1:['tier-ready','基础材料较齐','就自测勾选结果看，基础必检材料已较齐。正式递交前仍须对照当日官网清单与顾问核对原件规格，本结果不代表可递交或可获批。'],
  R2:['tier-gaps','仍有若干缺口','仍有若干必检材料待补齐或更新。建议按下方缺失清单逐项准备；补齐后可再跑一次自测。本结果仅为准备度参考。'],
  R3:['tier-priority','优先材料缺口较多','身份或公司优先材料缺口较多。建议先集中补齐清单中的优先项，再考虑时间表与顾问沟通。本工具不评估获批可能。'],
  R4:['tier-start','尚未开始准备','目前多数字段尚未确认或仍为「无」。可先从往来港澳通行证等必检身份文件与公司登记证明等基础项开始收集（护照为选检）。']
};
function selfcheck(s){
  if(!s) return '';
  var t=TIER[s['档']]||TIER.R2, n=s['到期日']?daysTo(s['到期日']):null;
  var li=function(arr,empty){return arr&&arr.length?arr.map(function(x){return '<li'+(x[2]?' class="expired"':'')+'>'+esc(x[0])+'：'+esc(x[1])+'</li>'}).join(''):'<li>'+empty+'</li>'};
  return '<section class="sec" id="s-self"><div class="sec-title"><h2>准备度自测结果</h2><span>高才通 / 优才 / 新加坡 EP 资料准备度自测</span></div>'+
  '<div class="notice">本工具由 HARTHELM 提供，仅供资料整理参考，不构成法律意见，亦非香港入境事务处、人才办、新加坡 MOM 或其他机关的官方系统或标准。清单以当日官网为准。</div>'+
  '<section class="card"><h2>自测结果</h2><p class="muted" style="margin:0">身份入口：'+esc(s['身份入口'])+(n!==null?' · '+(n>=0?'距填写的到期日约 '+n+' 天（仅参考）':'填写的到期日已过约 '+(-n)+' 天（仅参考）'):'')+' · 填写日期 '+esc(s['填写日期'])+'</p>'+
  '<div class="result-tier '+t[0]+'"><h3>'+t[1]+'</h3><p>'+t[2]+'</p></div>'+
  '<div class="miss"><h4>建议优先补齐</h4><ul>'+li(s['优先'],'必检项暂无缺失（仍须以官网为准）。')+'</ul><h4>可按情况补充</h4><ul>'+li(s['可选'],'无额外选检缺口，或未勾选选检项。')+'</ul></div></section>'+
  '<p class="muted">请勿将本结果理解为获批承诺、通过率或报价依据。</p></section>';
}

function policyShell(){return '<section class="sec" id="s-policy"><div class="sec-title"><h2>最新政策</h2><span id="pol-meta">正在读取…</span></div><div id="pol"></div></section>'}
function loadPolicy(){
  fetch('/data/policy.json',{cache:'no-store',credentials:'omit'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(p){
    $('pol-meta').innerHTML='<span class="badge">'+esc(p.status||'')+'</span>　'+esc(p.date||'')+(p.window?' · 覆盖 '+esc(p.window):'');
    var h=p.headline?'<section class="card"><b>本期结论：</b>'+esc(p.headline)+'</section>':'';
    h+=(p.items||[]).map(function(i){return '<section class="card pol"><h3><span class="lv">'+esc(i.level)+'</span>'+esc(i.title)+'</h3><p class="muted" style="margin:0">'+esc(i.region)+'</p><p>'+esc(i.summary)+'</p>'+
      (i.sources||[]).filter(function(s){return /^https:\/\//.test(s.url)}).map(function(s){return '<div><a href="'+esc(s.url)+'" target="_blank" rel="noopener noreferrer">↗ '+esc(s.label)+'</a></div>'}).join('')+'</section>'}).join('');
    h+=p.disclaimer?'<p class="muted">'+esc(p.disclaimer)+'</p>':'';
    $('pol').innerHTML=h;
  }).catch(function(){$('pol-meta').textContent='暂时无法读取最新政策';});
}

function render(d){
  var app=$('app');
  var nav=[['s-renew','续签进度',d['续签']],['s-diag','初步诊断',d['初诊']],['s-self','自测结果',d['自测']],['s-policy','最新政策',true]].filter(function(x){return x[2]});
  app.innerHTML=
    (d['测试']?'<div class="testbar">测试版 · 示例客户：以下全部为虚构资料，仅用于验收页面效果。</div>':'')+
    '<div class="hello"><h1>您好'+(d['称呼']?'，'+esc(d['称呼']):'')+'</h1><span class="meta">数据更新：'+esc(d['更新时间'])+'（香港时间）</span></div>'+
    '<nav class="nav" id="nav">'+nav.map(function(x,i){return '<a href="#'+x[0]+'"'+(i===0?' class="on"':'')+'>'+x[1]+'</a>'}).join('')+'</nav>'+
    renewal(d['续签'],d['更新时间'])+diagnosis(d['初诊'])+selfcheck(d['自测'])+policyShell()+
    '<div class="actions"><span class="muted">离开前请点「锁定」，或直接关闭页面。</span><button class="ghost" type="button" id="lock">锁定看板</button></div>';
  $('gate').classList.add('hidden'); app.classList.remove('hidden');
  document.title='客户看板 · HARTHELM';
  if(d['续签']){var tick=function(){var e=$('cd');if(e)e.textContent=cd(d['续签']['逗留期限'])};tick();timer=setInterval(tick,1000)}
  loadPolicy();
  $('lock').addEventListener('click',function(){clearInterval(timer);app.innerHTML='';location.replace(location.pathname)});
  var links=[].slice.call(document.querySelectorAll('#nav a'));
  links.forEach(function(a){a.addEventListener('click',function(){links.forEach(function(x){x.classList.remove('on')});a.classList.add('on')})});
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){links.forEach(function(x){x.classList.toggle('on',x.getAttribute('href')==='#'+e.target.id)})}})},{rootMargin:'-20% 0px -70% 0px'});
    nav.forEach(function(x){var s=$(x[0]);if(s)io.observe(s)});
  }
}
})();
