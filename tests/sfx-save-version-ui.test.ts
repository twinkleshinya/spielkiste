import assert from 'node:assert/strict';
import {editorHarness} from './sfx-edit-preview-ui.test.js';

export async function testNamedVersionDialog(){
 const ui=await editorHarness();
 ui.context.window.prompt=()=>{throw new Error('prompt unsupported');};
 ui.exec(`run.projectId='33333333-3333-4333-8333-333333333333';`);
 const before=ui.getRun();
 await ui.$('preserve').onclick();
 assert.equal(ui.$('save-version-dialog').open,true,'save must open an in-app naming dialog without window.prompt');
 assert.equal(ui.$('save-version-name').value,'','user supplies the version name');
 assert.equal(ui.calls.some(c=>c.url.endsWith('/save-version')),false,'opening the naming dialog must not save yet');
 ui.$('save-version-name').value='   ';
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.calls.some(c=>c.url.endsWith('/save-version')),false,'blank names must not be saved');
 assert.ok(ui.$('save-version-message').textContent.includes('名称'));
 ui.$('save-version-name').value='  吼叫与风声确认版  ';
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 const saved=ui.calls.find(c=>c.url.endsWith('/save-version'));
 assert.deepEqual(saved?.body,{name:'吼叫与风声确认版',runId:before.id});
 assert.notEqual(ui.getRun().id,before.id);
 assert.equal(ui.getRun().name,'吼叫与风声确认版');
 assert.equal(ui.$('save-version-dialog').open,false);
 assert.ok(ui.$('version-history').children.some((o:any)=>o.textContent?.includes('吼叫与风声确认版')));
 assert.deepEqual(ui.getRun().placements,before.placements);
 assert.equal(ui.calls.some(c=>/\/(edit-preview|render|reanalyze|reselect)$/.test(c.url)),false,'save a snapshot without re-rendering or reselecting');
}

export async function testNamedVersionFailureCanRetryAndCancel(){
 const ui=await editorHarness();
 ui.exec(`run.projectId='33333333-3333-4333-8333-333333333333';`);
 const before=ui.getRun();
 await ui.$('preserve').onclick();
 ui.$('save-version-name').value='保留的版本名';
 ui.failSaveVersion();
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.$('save-version-dialog').open,true);
 assert.equal(ui.$('save-version-name').value,'保留的版本名');
 assert.ok(ui.$('save-version-message').textContent.includes('test save failure'));
 assert.equal(ui.$('save-version-submit').disabled,false);
 assert.deepEqual(ui.getRun().placements,before.placements);
 assert.equal(ui.getRun().id,before.id);
 ui.failSaveVersion(false);
 await ui.$('save-version-form').onsubmit({preventDefault(){}});
 assert.equal(ui.getRun().name,'保留的版本名');
 await ui.$('preserve').onclick();
 const count=ui.calls.length;
 ui.$('save-version-cancel').onclick();
 assert.equal(ui.$('save-version-dialog').open,false);assert.equal(ui.calls.length,count);
}

export async function testNamedVersionExplainsPendingEdits(){
 const ui=await editorHarness();
 await ui.exec(`quickEdit('placement','p-boss','mute')`);
 await ui.$('preserve').onclick();
 assert.equal(ui.calls.some(c=>c.url.endsWith('/save-version')),false);
 assert.ok(ui.$('status').textContent.includes('更新视频预览'),'pending edits need an actionable explanation');
}
