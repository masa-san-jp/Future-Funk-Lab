// One autosave slot in IndexedDB: the source audio and the latest session JSON.
const DB='future-funk-lab', STORE='autosave';
function open(){
  return new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(Error('IndexedDBを利用できません'));return;}
    const request=indexedDB.open(DB,1);
    request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function transaction(mode,fn){
  const db=await open();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,mode),request=fn(tx.objectStore(STORE));
      tx.oncomplete=()=>resolve(request?.result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('自動保存に失敗しました'));
    });
  }finally{db.close();}
}
export const autosave={
  get:key=>transaction('readonly',store=>store.get(key)),
  put:(key,value)=>transaction('readwrite',store=>store.put(value,key)),
  clear:()=>transaction('readwrite',store=>store.clear())
};
