// Builds an AIFF or AIFF-C file in memory, so tests need no audio fixtures.
export function makeAiff({channels=2,bits=16,rate=44100,codec=null,data}){
  const width=Math.ceil(bits/8),frames=data.length/channels/width,aifc=codec!=null,comm=aifc?24:18,size=4+8+comm+8+8+data.length;
  const out=new Uint8Array(8+size),v=new DataView(out.buffer),put=(at,s)=>[...s].forEach((c,i)=>out[at+i]=c.charCodeAt(0));
  put(0,'FORM');v.setUint32(4,size);put(8,aifc?'AIFC':'AIFF');put(12,'COMM');v.setUint32(16,comm);
  v.setUint16(20,channels);v.setUint32(22,frames);v.setUint16(26,bits);
  const e=Math.floor(Math.log2(rate));v.setUint16(28,16383+e);v.setUint32(30,rate*2**(31-e));v.setUint32(34,0);
  if(aifc){put(38,codec);v.setUint16(42,0);}
  const s=20+comm;put(s,'SSND');v.setUint32(s+4,8+data.length);v.setUint32(s+8,0);v.setUint32(s+12,0);out.set(data,s+16);
  return out;
}
