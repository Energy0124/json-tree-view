import * as vscode from 'vscode';
import * as json from 'jsonc-parser';
import * as path from 'path';
import { isNumber } from 'util';
import { validate } from './schema-validator';
import * as fs from 'fs';

export class JsonOutlineProvider implements vscode.TreeDataProvider<number> {

	private _onDidChangeTreeData: vscode.EventEmitter<number | null> = new vscode.EventEmitter<number | null>();
	readonly onDidChangeTreeData: vscode.Event<number | null> = this._onDidChangeTreeData.event;

	private tree: json.Node;
	private text: string;
	private editor: vscode.TextEditor;
	private autoRefresh: boolean = true;
	private error_paths: (string | number)[][];
	private customized_view_mapping: { [key: string]: string } = undefined;

	constructor(private context: vscode.ExtensionContext) {
		vscode.window.onDidChangeActiveTextEditor(() => this.onActiveEditorChanged());
		vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e));
		this.error_paths = this.validate();
		this.loadCustomizedView();
		this.parseTree();
		this.autoRefresh = vscode.workspace.getConfiguration('jsonOutline').get('autorefresh');
		vscode.workspace.onDidChangeConfiguration(() => {
			this.autoRefresh = vscode.workspace.getConfiguration('jsonOutline').get('autorefresh');
		});
		this.onActiveEditorChanged();
	}

	refresh(offset?: number): void {
		this.parseTree();
		if (offset) {
			this._onDidChangeTreeData.fire(offset);
		} else {
			this._onDidChangeTreeData.fire();
		}
	}

	rename(offset: number): void {
		vscode.window.showInputBox({ placeHolder: 'Enter the new label' })
			.then(value => {
				if (value !== null && value !== undefined) {
					this.editor.edit(editBuilder => {
						const path = json.getLocation(this.text, offset).path;
						let propertyNode = json.findNodeAtLocation(this.tree, path);
						if (propertyNode.parent.type !== 'array') {
							propertyNode = propertyNode.parent.children[0];
						}
						const range = new vscode.Range(this.editor.document.positionAt(propertyNode.offset), this.editor.document.positionAt(propertyNode.offset + propertyNode.length));
						editBuilder.replace(range, `"${value}"`);
						setTimeout(() => {
							this.parseTree();
							this.refresh(offset);
						}, 100);
					});
				}
			});
	}

	validate(): (string | number)[][] {
		let error_paths_string = validate(JSON.parse(vscode.window.activeTextEditor.document.getText()));
		let error_paths: (string | number)[][] = [];

		for (let i = 0; i < error_paths_string.length; i++) {
			let error_path = error_paths_string[i].split('.').slice(1);
			error_paths.push(error_path);
		}

		return error_paths;
	}

	private onActiveEditorChanged(): void {
		if (vscode.window.activeTextEditor) {
			if (vscode.window.activeTextEditor.document.uri.scheme === 'file') {
				const enabled = vscode.window.activeTextEditor.document.languageId === 'json' || vscode.window.activeTextEditor.document.languageId === 'jsonc';
				vscode.commands.executeCommand('setContext', 'jsonOutlineEnabled', enabled);
				if (enabled) {
					this.refresh();
				}
			}
		} else {
			vscode.commands.executeCommand('setContext', 'jsonOutlineEnabled', false);
		}
	}

	private onDocumentChanged(changeEvent: vscode.TextDocumentChangeEvent): void {
		if (this.autoRefresh && changeEvent.document.uri.toString() === this.editor.document.uri.toString()) {
			for (const change of changeEvent.contentChanges) {
				const path = json.getLocation(this.text, this.editor.document.offsetAt(change.range.start)).path;
				path.pop();
				const node = path.length ? json.findNodeAtLocation(this.tree, path) : void 0;
				this.parseTree();
				this._onDidChangeTreeData.fire(node ? node.offset : void 0);
			}
		}
	}

	private parseTree(): void {
		this.text = '';
		this.tree = null;
		this.editor = vscode.window.activeTextEditor;
		if (this.editor && this.editor.document) {
			this.text = this.editor.document.getText();
			this.tree = json.parseTree(this.text);
		}
	}

	private loadCustomizedView(): void {
		let path = vscode.workspace.rootPath + "/config/customizedView.json";
		let customizedViewConfig = fs.readFileSync(path, 'utf8');

		if (IsJsonString(customizedViewConfig)) {
			this.customized_view_mapping = JSON.parse(customizedViewConfig);
		}
	}

	getChildren(offset?: number): Thenable<number[]> {
		if (offset) {
			const path = json.getLocation(this.text, offset).path;
			const node = json.findNodeAtLocation(this.tree, path);
			return Promise.resolve(this.getChildrenOffsets(node));
		} else {
			return Promise.resolve(this.tree ? this.getChildrenOffsets(this.tree) : []);
		}
	}

	private getChildrenOffsets(node: json.Node): number[] {
		const offsets: number[] = [];
		for (const child of node.children) {
			const childPath = json.getLocation(this.text, child.offset).path;
			const childNode = json.findNodeAtLocation(this.tree, childPath);
			if (childNode) {
				offsets.push(childNode.offset);
			}
		}
		return offsets;
	}

	getTreeItem(offset: number): vscode.TreeItem {
		const path = json.getLocation(this.text, offset).path;
		const valueNode = json.findNodeAtLocation(this.tree, path);
		if (valueNode) {
			let hasChildren = valueNode.type === 'object' || valueNode.type === 'array';
			let treeItem: vscode.TreeItem = new vscode.TreeItem(
				this.getLabel(valueNode),
				hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
			treeItem.command = {
				command: 'extension.openJsonSelection',
				title: '',
				arguments: [new vscode.Range(this.editor.document.positionAt(valueNode.offset), this.editor.document.positionAt(valueNode.offset + valueNode.length))]
			};

			let flag = ifArrayAInArrayB(path, this.error_paths);
			
			/* If tree item's path is in error paths, assign it an error icon */
			if (!flag) {
				treeItem.iconPath = this.getIcon(valueNode);
			} else {
				treeItem.iconPath = this.getErrorIcon();
			}

			treeItem.contextValue = valueNode.type;
			return treeItem;
		}
		return null;
	}

	select(range: vscode.Range) {
		this.editor.selection = new vscode.Selection(range.start, range.end);
		this.editor.revealRange(range);
	}

	private getIcon(node: json.Node): any {
		let nodeType = node.type;
		if (nodeType === 'boolean') {
			return {
				light: this.context.asAbsolutePath(path.join('resources', 'light', 'boolean.svg')),
				dark: this.context.asAbsolutePath(path.join('resources', 'dark', 'boolean.svg'))
			};
		}
		if (nodeType === 'string') {
			return {
				light: this.context.asAbsolutePath(path.join('resources', 'light', 'string.svg')),
				dark: this.context.asAbsolutePath(path.join('resources', 'dark', 'string.svg'))
			};
		}
		if (nodeType === 'number') {
			return {
				light: this.context.asAbsolutePath(path.join('resources', 'light', 'number.svg')),
				dark: this.context.asAbsolutePath(path.join('resources', 'dark', 'number.svg'))
			};
		}
		
		return null;
	}

	private getErrorIcon(): any {
		return {
			light: this.context.asAbsolutePath(path.join('resources', 'light', 'error.svg')),
			dark: this.context.asAbsolutePath(path.join('resources', 'dark', 'error.svg'))
		};
	}

	private getLabel(node: json.Node): string {
		if (node.parent.type === 'array') {
			let parentKey = node.parent.parent.children[0].value.toString();

			if (this.customized_view_mapping !== undefined && parentKey in this.customized_view_mapping) {
				let key: string = this.customized_view_mapping[parentKey];

				for (let i = 0; i < node.children.length; i++) {
					if (node.children[i].children[0].value === key) {
						return node.children[i].children[1].value + ' { }';
					}
				} 
			} 
			
			else {
				let prefix = parentKey + ' ' + node.parent.children.indexOf(node).toString();

				if (node.type === 'object') {
					return prefix + ' { }';
				}
				if (node.type === 'array') {
					return prefix + ' [' + node.children.length + ']';
				}

				return prefix + ': ' + node.value.toString();
			}
		}
		else {
			const property = node.parent.children[0].value.toString();
			if (node.type === 'array' || node.type === 'object') {
				if (node.type === 'object') {
					return property + ' { }';
				}
				if (node.type === 'array') {
					return property + ' [' + node.children.length + ']';
				}
			}
			const value = this.editor.document.getText(new vscode.Range(this.editor.document.positionAt(node.offset), this.editor.document.positionAt(node.offset + node.length)));
			return `${property}: ${value}`;
		}
	}
}

function ifArrayAInArrayB(A:(string | number)[], B:(string | number)[][]) {
	let A_flatten = (A.map(x => x.toString())).join();
	let B_flatten = B.map(x => x.join());

	return withinOf(A_flatten, B_flatten);
}

function withinOf(A: string, B: string[]) {
	for (let i = 0; i < B.length; i++) {
		let A_array = A.split(',');
		let B_sub_array = B[i].split(',');

		/* return true if A_array is a sub array of B_sub_array */
		if (A_array.length <= B_sub_array.length) {
			let j;
			for (j = 0; j < A_array.length; j++) {
				if (A_array[j] !== B_sub_array[j]) {
					break;
				}
			}

			if (j === A_array.length) {
				return true;
			}
		}
	}
	
	return false;
}

function IsJsonString(str: string) {
    try {
        JSON.parse(str);
    } catch (e) {
        return false;
    }
    return true;
}