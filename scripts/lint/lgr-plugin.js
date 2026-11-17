// FR-32.5 (#797): the two rules of the linter that oxlint has no rule for, as an oxlint JS plugin
// (ESLint's rule API). `.oxlintrc.json` turns them on; `scripts/lint.ts` runs them against the
// baseline. Kept to what the spec names, and no wider: more rules are added only when one of them
// would have caught a defect that reached master (§2.3).

/** A comment anywhere in the node's text: the reason a person left for ignoring the error. */
const hasComment = (context, node) => /\/\/|\/\*/.test(context.sourceCode.getText(node))

const isFunction = node => node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression')

export default {
  meta: { name: 'lgr' },
  rules: {
    // `catch {}` / `catch (e) {}`: the error is gone and nothing says why. A block that holds only a
    // comment passes, as ESLint's `no-empty` lets it: the comment is the reason (§2.3).
    'no-empty-catch': {
      meta: { type: 'problem', docs: { description: 'an empty catch block drops its error' } },
      create(context) {
        return {
          CatchClause(node) {
            if (node.body.body.length === 0 && !hasComment(context, node.body)) {
              context.report({ node: node.body, message: 'An empty catch drops its error: handle it, report it, or say in a comment why it is ignored.' })
            }
          },
        }
      },
    },

    // `.catch(() => …)`: a handler that takes no error cannot handle or report it. One whose body
    // says why in a comment passes.
    'catch-drops-error': {
      meta: { type: 'problem', docs: { description: 'a .catch() handler that takes no error drops it' } },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee
            if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'catch') return
            const handler = node.arguments[0]
            if (isFunction(handler) && handler.params.length === 0 && !hasComment(context, handler)) {
              context.report({ node: handler, message: 'This .catch() handler takes no error, so it drops it: handle it, report it, or say in a comment why it is ignored.' })
            }
          },
        }
      },
    },

    // `x as any` / `<any>x`: the cast that hides what the types would have said (§1.4, C2). Only
    // the cast: a declared `: any` is FR-32.17's count, not this rule's.
    'no-as-any': {
      meta: { type: 'problem', docs: { description: 'no new `as any`' } },
      create(context) {
        const check = node => {
          if (node.typeAnnotation && node.typeAnnotation.type === 'TSAnyKeyword') {
            context.report({ node, message: 'No new `as any`: give the value its type, or cast to what it is.' })
          }
        }
        return { TSAsExpression: check, TSTypeAssertion: check }
      },
    },
  },
}
