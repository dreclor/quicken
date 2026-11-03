import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
try{
  const token=readFileSync(resolve(process.env.QUICKEN_DATA_DIR||'.quicken','access-token'),'utf8').trim();
  const url=`http://127.0.0.1:${process.env.PORT||4317}/#access=${token}`;
  const cmd=process.platform==='darwin'?'open':process.platform==='win32'?'cmd':'xdg-open';
  spawn(cmd,process.platform==='win32'?['/c','start','',url]:[url],{stdio:'ignore',detached:true}).unref();
  console.log('Opened Quicken in your browser.');
}catch{console.error('Start the server with npm start first.');process.exitCode=1;}
