import { clamp, formatTime } from './core.js';
export class Waveform {
  constructor(canvas,{onRange,onBoundary,onSeek,onTogglePlay,onSetEndpoint}={}){
    this.canvas=canvas;this.onRange=onRange;this.onBoundary=onBoundary;this.onSeek=onSeek;this.onTogglePlay=onTogglePlay;this.onSetEndpoint=onSetEndpoint;this.zoom=1;this.scroll=0;this.points=[];this.cursor=null;this.selected=1;this.tool='select';
    this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(canvas);
    canvas.addEventListener('pointerdown',event=>this.down(event));
    canvas.addEventListener('pointermove',event=>this.move(event));
    canvas.addEventListener('pointerup',event=>this.up(event));
    canvas.addEventListener('click',event=>{
      if(!this.onRange||!this.onSeek||!this.channels)return;
      if(this.suppressSeekClick){this.suppressSeekClick=false;return;}
      const rect=canvas.getBoundingClientRect();
      const time=event.detail===0&&event.clientX===0&&event.clientY===0?this.cursor??0:this.timeAt(event.clientX-rect.left);
      if(this.tool==='start'||this.tool==='end'){this.onSetEndpoint?.(this.tool==='start'?0:1,time);return;}
      this.onSeek(time);
    });
    canvas.addEventListener('pointercancel',()=>{this.suppressSeekClick=true;this.drag=null;this.updateCursor();});
    canvas.addEventListener('lostpointercapture',()=>{this.drag=null;this.updateCursor();});
    canvas.addEventListener('keydown',event=>{
      if(this.onRange&&this.onSeek&&this.channels){
        if(event.code==='Space'){event.preventDefault();this.onTogglePlay?.();return;}
        if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
          event.preventDefault();
          const time=event.key==='Home'?0:event.key==='End'?this.duration-1/this.rate:(this.cursor??0)+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?.1:1);
          this.onSeek(clamp(time,0,this.duration-1/this.rate));return;
        }
      }
      if(!this.onBoundary||!['ArrowLeft','ArrowRight'].includes(event.key)||this.points.length<3)return;
      event.preventDefault();this.onBoundary(this.selected,this.points[this.selected]+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?.010:.001),{keyboard:true,direction:event.key==='ArrowRight'?1:-1});
    });
    canvas.addEventListener('wheel',event=>{
      if(this.zoom<=1)return;
      event.preventDefault();
      const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
      const unit=event.deltaMode===1?16:event.deltaMode===2?this.width:1;
      this.setScroll(this.scroll+delta*unit/(this.width||1)/this.zoom);
    },{passive:false});
  }
  set(channels,rate,range=null,points=null){this.channels=channels;this.rate=rate;this.duration=channels?channels[0].length/rate:0;if(range)this.range=[...range];if(points)this.points=[...points];this.buildPeaks();this.draw();}
  buildPeaks(){
    this.peaks=this.channels?.map(channel=>{
      const block=128,n=Math.ceil(channel.length/block),min=new Float32Array(n),max=new Float32Array(n);
      for(let i=0;i<n;i++){let lo=0,hi=0;for(let j=i*block;j<Math.min(channel.length,(i+1)*block);j++){lo=Math.min(lo,channel[j]);hi=Math.max(hi,channel[j]);}min[i]=lo;max[i]=hi;}
      return {min,max,block};
    });
  }
  get visible(){return this.duration/this.zoom;}
  timeAt(x){return clamp(this.scroll*this.duration+x/this.width*this.visible,0,this.duration);}
  xAt(time){return (time-this.scroll*this.duration)/this.visible*this.width;}
  setScroll(value){this.scroll=clamp(value,0,1-1/this.zoom);this.onScroll?.(this.scroll);this.draw();}
  setZoom(value){
    const center=this.scroll*this.duration+this.visible/2;
    const anchor=this.cursor!=null&&this.xAt(this.cursor)>=0&&this.xAt(this.cursor)<=this.width?this.cursor:center;
    this.zoom=value;
    this.setScroll(this.duration?(anchor-this.visible/2)/this.duration:0);
    this.updateCursor();
  }
  setTool(tool){this.tool=tool;this.updateCursor();}
  rangeHandleAt(x,y){
    if(!this.range||y<0||y>this.canvas.clientHeight-18)return -1;
    const distances=this.range.map(t=>Math.abs(this.xAt(t)-x));
    const index=distances[0]<=distances[1]?0:1;
    return distances[index]<=(y<=20?12:6)?index:-1;
  }
  updateCursor(x=null,y=null){
    if(!this.onRange||!this.onSeek)return;
    this.canvas.style.cursor=this.drag?.kind==='range'?'ew-resize':this.drag?.kind==='pan'&&this.drag.moved?'grabbing':this.tool==='pan'?'grab':this.tool==='start'||this.tool==='end'?'crosshair':x!=null&&this.rangeHandleAt(x,y)>=0?'ew-resize':'crosshair';
  }
  down(event){
    if(!this.channels||event.button!==0)return;
    this.suppressSeekClick=false;
    const rect=this.canvas.getBoundingClientRect(), x=event.clientX-rect.left, y=event.clientY-rect.top, time=this.timeAt(x);
    this.canvas.focus();this.canvas.setPointerCapture(event.pointerId);
    if(this.onRange&&this.onSeek){
      if(this.tool==='start'||this.tool==='end'){this.drag={kind:'endpoint'};this.updateCursor();return;}
      const pan=this.tool==='pan'||event.shiftKey;
      const index=pan?-1:this.rangeHandleAt(x,y);
      this.drag=index>=0?{kind:'range',index}:{kind:pan?'pan':'select',x,y,anchor:time,scroll:this.scroll,moved:false};
      this.updateCursor(x,y);
    }
    else if(this.onRange){const distances=this.range.map(t=>Math.abs(this.xAt(t)-x));this.drag={kind:'range',index:distances[0]<=distances[1]?0:1};this.move(event);}
    else if(this.onBoundary){let best=1;for(let i=1;i<this.points.length-1;i++)if(Math.abs(this.xAt(this.points[i])-x)<Math.abs(this.xAt(this.points[best])-x))best=i;this.selected=best;this.drag={index:best};this.move(event);}
    else this.onSeek?.(time);
  }
  move(event){
    const rect=this.canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
    if(!this.drag){this.updateCursor(x,y);return;}
    if(this.drag.kind==='endpoint')return;
    if(this.drag.kind==='pan'||this.drag.kind==='select'){
      const delta=x-this.drag.x;
      if(Math.abs(delta)>8)this.drag.moved=true;
      if(this.drag.moved){
        if(this.drag.kind==='pan')this.setScroll(this.drag.scroll-delta/this.width/this.zoom);
        else{
          const time=this.timeAt(x),minimum=Math.max(.001,1/this.rate);
          let start=Math.min(this.drag.anchor,time),end=Math.max(this.drag.anchor,time);
          if(end-start<minimum){end=Math.min(this.duration,start+minimum);start=Math.max(0,end-minimum);}
          this.range=[start,end];this.onRange([...this.range]);this.draw();
        }
        this.updateCursor();
      }
      return;
    }
    const time=this.timeAt(x);
    if(this.onRange){const next=[...this.range],i=this.drag.index;next[i]=clamp(time,i===0?0:next[0]+.001,i===0?next[1]-.001:this.duration);this.range=next;this.onRange(next);this.draw();}
    else this.onBoundary?.(this.drag.index,time);
  }
  up(event){
    const drag=this.drag;this.drag=null;
    if(this.onRange&&this.onSeek)this.suppressSeekClick=drag?.kind==='range'||Boolean(drag?.moved);
    if(this.canvas.hasPointerCapture(event.pointerId))this.canvas.releasePointerCapture(event.pointerId);
    this.updateCursor();
  }
  draw(){
    const width=this.canvas.clientWidth||600,height=this.canvas.clientHeight||120,dpr=window.devicePixelRatio||1;this.width=width;
    this.canvas.width=Math.round(width*dpr);this.canvas.height=Math.round(height*dpr);const ctx=this.canvas.getContext('2d');ctx.scale(dpr,dpr);
    ctx.fillStyle='#10131a';ctx.fillRect(0,0,width,height);
    if(!this.channels){ctx.fillStyle='#747d91';ctx.font='12px system-ui';ctx.textAlign='center';ctx.fillText('音源を読み込むと波形を表示します',width/2,height/2);return;}
    const top=18,bottom=18,lane=(height-top-bottom)/2;
    if(this.gridSeconds){
      const stride=Math.max(1,Math.ceil(this.visible/this.gridSeconds/(width/12))),grid=this.gridSeconds*stride;
      for(let i=Math.ceil(this.scroll*this.duration/grid);i*grid<=this.scroll*this.duration+this.visible;i++){
        const x=this.xAt(i*grid);ctx.strokeStyle=(i*stride)%2===0?'#45536b':'#29354a';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();
      }
    }else for(let i=0;i<=8;i++){const x=i*width/8;ctx.strokeStyle='#202635';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();}
    this.channels.slice(0,2).forEach((channel,c)=>{
      const center=top+lane*(c+.5),amplitude=lane*.44;ctx.strokeStyle=c===0?'#65d4c0':'#58a8c5';ctx.lineWidth=1;
      const samplesPerPixel=this.visible*this.rate/width,p=this.peaks[c];ctx.beginPath();
      for(let x=0;x<width;x++){const a=Math.max(0,Math.floor((this.scroll*this.duration+x/width*this.visible)*this.rate)),b=Math.min(channel.length,Math.max(a+1,Math.ceil(a+samplesPerPixel)));let min=0,max=0;
        if(samplesPerPixel>=256){for(let k=Math.floor(a/p.block);k<Math.ceil(b/p.block);k++){min=Math.min(min,p.min[k]||0);max=Math.max(max,p.max[k]||0);}}
        else for(let k=a;k<b;k++){min=Math.min(min,channel[k]);max=Math.max(max,channel[k]);}
        ctx.moveTo(x,center-min*amplitude);ctx.lineTo(x,center-max*amplitude);
      }ctx.stroke();ctx.fillStyle='#6e798e';ctx.font='10px system-ui';ctx.fillText(c?'R':'L',5,center-4);
    });
    if(this.range){
      const [a,b]=this.range.map(t=>this.xAt(t));
      ctx.fillStyle='#070a1280';ctx.fillRect(0,top,clamp(a,0,width),height-top-bottom);ctx.fillRect(clamp(b,0,width),top,width-clamp(b,0,width),height-top-bottom);
      ctx.fillStyle='#ef78ad30';ctx.fillRect(a,top,b-a,height-top-bottom);this.range.forEach(t=>this.marker(ctx,this.xAt(t),height,true));
    }
    if(this.playbackRange){const [a,b]=this.playbackRange.map(t=>this.xAt(t));ctx.fillStyle='#65d4c026';ctx.fillRect(a,top,b-a,height-top-bottom);}
    if(this.points.length){this.points.forEach((t,i)=>{const x=this.xAt(t);ctx.setLineDash([3,4]);ctx.strokeStyle='#ef78ad';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();ctx.setLineDash([]);this.marker(ctx,x,height,i===0||i===this.points.length-1,i===this.selected);if(i<this.points.length-1){ctx.fillStyle='#e6deea';ctx.font='11px monospace';ctx.fillText(String(i+1),x+6,top+12);}});}
    if(this.cursor!=null){const x=this.xAt(this.cursor);ctx.strokeStyle='#fff';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();}
    ctx.fillStyle='#7c879d';ctx.font='10px monospace';ctx.textAlign='left';ctx.fillText(formatTime(this.scroll*this.duration),4,height-4);ctx.textAlign='right';ctx.fillText(formatTime(Math.min(this.duration,this.scroll*this.duration+this.visible)),width-4,height-4);ctx.textAlign='left';
  }
  marker(ctx,x,height,filled,selected=false){ctx.fillStyle=selected?'#fff':'#ef78ad';ctx.strokeStyle=ctx.fillStyle;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(x-6,3);ctx.lineTo(x+6,3);ctx.lineTo(x,13);ctx.closePath();if(filled||selected)ctx.fill();else ctx.stroke();ctx.beginPath();ctx.moveTo(x,14);ctx.lineTo(x,height-18);ctx.stroke();}
}
