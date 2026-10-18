import { transform, encodeMp3 } from './dsp.js';
import { detectBpm } from './core.js';
self.onmessage=({data:{id,type,channels,rate,tempo,pitch}})=>{
  try {
    const result=type==='transform'?transform(channels,rate,tempo,pitch):type==='detect'?detectBpm(channels,rate):encodeMp3(channels,rate);
    const transfers=Array.isArray(result)?result.map(c=>c.buffer):result instanceof Uint8Array?[result.buffer]:[];
    self.postMessage({id,result},transfers);
  } catch(error){self.postMessage({id,error:error.message});}
};
