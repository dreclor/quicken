const fragment=new URLSearchParams(location.hash.slice(1));
if(fragment.has('access')){localStorage.setItem('quicken-access',fragment.get('access')!);history.replaceState(null,'',location.pathname);}
export const accessToken=()=>localStorage.getItem('quicken-access')||'';
export async function api<T=any>(path:string,options:RequestInit={}) : Promise<T> {
  const isForm=options.body instanceof FormData;
  const response=await fetch('/api'+path,{...options,headers:{'x-quicken-token':accessToken(),...(!isForm&&options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
  if(!response.ok){const error=await response.json().catch(()=>({error:'Request failed.'}));throw new Error(error.error||'Request failed.');}
  return await response.json();
}
export async function exportMeeting(id:string){const r=await fetch(`/api/meetings/${id}/export`,{headers:{'x-quicken-token':accessToken()}});if(!r.ok)throw new Error('Export failed.');const url=URL.createObjectURL(await r.blob());const link=document.createElement('a');link.href=url;link.download='quicken-meeting.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
