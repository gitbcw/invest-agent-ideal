/**
 * 安全表达式解析器(L3a 规则树专用)
 *
 * 支持:
 *   优先级递增(从低到高):
 *     ||  →  &&  →  == !=  →  < <= > >=  →  + -  →  * / %  →  一元 -!  →  primary
 *   primary: 数字字面量 / 字段引用 / (expr)
 *
 * 严格禁止:
 *   - eval / new Function
 *   - 函数调用语法 ident(...)
 *   - 字符串字面量(避免字符串拼接绕过白名单)
 *   - 不在白名单里的标识符
 *
 * 超时熔断:evaluate 接受 startedAt,若超出 timeoutMs 抛错。
 */

const TOKEN_RE = /(\s+)|(>=|<=|==|!=|&&|\|\||[-+*/%<>!()])/g;

type TokenType =
  | "NUMBER"
  | "IDENT"
  | "OP"
  | "LPAREN"
  | "RPAREN"
  | "EOF";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export class RuleExpressionError extends Error {
  constructor(message: string, readonly pos?: number) {
    super(`RuleExpressionError: ${message}${pos !== undefined ? ` (at ${pos})` : ""}`);
    this.name = "RuleExpressionError";
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(\d+\.?\d*|\.\d+)/.exec(source.slice(i)))) {
      tokens.push({ type: "NUMBER", value: m[1], pos: i });
      i += m[1].length;
      continue;
    }
    if ((m = /^([A-Za-z_]\w*)/.exec(source.slice(i)))) {
      tokens.push({ type: "IDENT", value: m[1], pos: i });
      i += m[1].length;
      continue;
    }
    if ((m = /^(>=|<=|==|!=|&&|\|\||[-+*/%<>!()])/.exec(source.slice(i)))) {
      const v = m[1];
      if (v === "(") tokens.push({ type: "LPAREN", value: v, pos: i });
      else if (v === ")") tokens.push({ type: "RPAREN", value: v, pos: i });
      else tokens.push({ type: "OP", value: v, pos: i });
      i += v.length;
      continue;
    }
    throw new RuleExpressionError(`unexpected character '${ch}'`, i);
  }
  tokens.push({ type: "EOF", value: "", pos: source.length });
  return tokens;
}

// AST 节点
type Node =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "unary"; op: "-" | "!"; operand: Node }
  | { kind: "binary"; op: BinaryOp; left: Node; right: Node };

type BinaryOp =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expectOp(op: string): void {
    const t = this.peek();
    if (t.type !== "OP" || t.value !== op) {
      throw new RuleExpressionError(`expected '${op}', got '${t.value || t.type}'`, t.pos);
    }
    this.advance();
  }

  parseExpr(): Node {
    const node = this.parseOr();
    const eof = this.peek();
    if (eof.type !== "EOF") {
      throw new RuleExpressionError(`unexpected trailing '${eof.value}'`, eof.pos);
    }
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().type === "OP" && this.peek().value === "||") {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEq();
    while (this.peek().type === "OP" && this.peek().value === "&&") {
      this.advance();
      const right = this.parseEq();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseEq(): Node {
    let left = this.parseCmp();
    while (this.peek().type === "OP" && (this.peek().value === "==" || this.peek().value === "!=")) {
      const op = this.advance().value as "==" | "!=";
      const right = this.parseCmp();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseCmp(): Node {
    let left = this.parseAdd();
    while (
      this.peek().type === "OP" &&
      ["<", "<=", ">", ">="].includes(this.peek().value)
    ) {
      const op = this.advance().value as BinaryOp;
      const right = this.parseAdd();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAdd(): Node {
    let left = this.parseMul();
    while (this.peek().type === "OP" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.advance().value as "+" | "-";
      const right = this.parseMul();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseMul(): Node {
    let left = this.parseUnary();
    while (
      this.peek().type === "OP" &&
      ["*", "/", "%"].includes(this.peek().value)
    ) {
      const op = this.advance().value as BinaryOp;
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.type === "OP" && (t.value === "-" || t.value === "!")) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: "unary", op: t.value as "-" | "!", operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.advance();
    if (t.type === "NUMBER") {
      return { kind: "num", value: parseFloat(t.value) };
    }
    if (t.type === "IDENT") {
      // 拒绝函数调用语法:ident(...)
      const next = this.peek();
      if (next.type === "LPAREN") {
        throw new RuleExpressionError(
          `function call syntax not allowed: '${t.value}('`,
          t.pos,
        );
      }
      // 保留字:true / false
      if (t.value === "true") return { kind: "num", value: 1 };
      if (t.value === "false") return { kind: "num", value: 0 };
      return { kind: "ident", name: t.value };
    }
    if (t.type === "LPAREN") {
      const inner = this.parseOr();
      const close = this.peek();
      if (close.type !== "RPAREN") {
        throw new RuleExpressionError("expected ')'", close.pos);
      }
      this.advance();
      return inner;
    }
    throw new RuleExpressionError(`unexpected token '${t.value || t.type}'`, t.pos);
  }
}

/**
 * 编译表达式为 AST(可缓存复用)。
 * 编译阶段即完成所有词法/语法错误检查。
 */
export function compileExpression(source: string): Node {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parseExpr();
}

/**
 * 求值。whitelist 必须涵盖所有引用的 ident,否则报错。
 */
export function evaluateExpression(
  ast: Node,
  whitelist: Set<string>,
  scope: Record<string, number | boolean>,
  options?: { timeoutMs?: number; startedAt?: number },
): number | boolean {
  const timeoutMs = options?.timeoutMs ?? 100;
  const startedAt = options?.startedAt ?? Date.now();

  const visit = (node: Node): number | boolean => {
    if (Date.now() - startedAt > timeoutMs) {
      throw new RuleExpressionError(`expression timed out after ${timeoutMs}ms`);
    }
    switch (node.kind) {
      case "num":
        return node.value;
      case "ident": {
        if (!whitelist.has(node.name)) {
          throw new RuleExpressionError(`identifier not in whitelist: '${node.name}'`);
        }
        if (!(node.name in scope)) {
          throw new RuleExpressionError(`missing input value for '${node.name}'`);
        }
        return scope[node.name];
      }
      case "unary": {
        const v = visit(node.operand);
        return node.op === "-" ? -toNum(v) : !toBool(v);
      }
      case "binary": {
        const l = visit(node.left);
        const r = visit(node.right);
        return applyBinary(node.op, l, r);
      }
    }
  };

  return visit(ast);
}

function toNum(v: number | boolean): number {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

function toBool(v: number | boolean): boolean {
  return typeof v === "number" ? v !== 0 : v;
}

function applyBinary(op: BinaryOp, l: number | boolean, r: number | boolean): number | boolean {
  switch (op) {
    case "||":
      return toBool(l) || toBool(r);
    case "&&":
      return toBool(l) && toBool(r);
    case "==":
      return toNum(l) === toNum(r);
    case "!=":
      return toNum(l) !== toNum(r);
    case "<":
      return toNum(l) < toNum(r);
    case "<=":
      return toNum(l) <= toNum(r);
    case ">":
      return toNum(l) > toNum(r);
    case ">=":
      return toNum(l) >= toNum(r);
    case "+":
      return toNum(l) + toNum(r);
    case "-":
      return toNum(l) - toNum(r);
    case "*":
      return toNum(l) * toNum(r);
    case "/":
      return toNum(l) / toNum(r);
    case "%":
      return toNum(l) % toNum(r);
  }
}
