// const curry = require('curry');
const jp = require('jsonpath')
const F = require('functional-pipelines')
const bins = require('./builtins');
const sx = require('./strings');

const sortBy = (sortBy, {mapping = v => v, asc = true} = {}) => {
    return (a, b) => {
        if (!asc) [a, b] = [b, a];
        return +(mapping(a[sortBy]) > mapping(b[sortBy])) || +(mapping(a[sortBy]) === mapping(b[sortBy])) - 1;
    };
};

const regex = {
    safeDot: /\.(?![\w\.]+")/,
    memberOrDescendant: /^[\[\.]/,
    fnArgsSeparator: /\s*:\s*/
};

const jpify = path => path.startsWith('$') ? path : regex.memberOrDescendant.test(path) ? `$${path}` : `$.${path}`;

const deref = sources => (ast, {meta = 1, source = 'origin'} = {}) => {
    const document = sources[source];
    let values;
    if (F.isNil(document)) {
        values = [];
    } else if (!F.isContainer(document)) {
        meta = 0;
        values = [document]; // literal value
    } else {
        values = jp.query(document, jpify(ast.path));
    }
    return {...ast, '@meta': meta, value: values};
};

const query = (ast, {meta = 2} = {}) => {
    let queryOp = values => values.pop();

    if (jp.value(ast, '$.operators.query')) {
        const regex = /\+(\d*)/;
        let {take} = sx.tokenize(regex, ast.operators.query, {tokenNames: ['take']});
        queryOp = bins.take(take);
    }
    // return F.withOneSlot(F.take)(take, F.__);
    return {...ast, '@meta': meta, value: queryOp(ast.value)};
};

const constraints = ({sources, tagHandlers, config}) => (ast, {meta = 2} = {}) => {
    const ops = {
        '?': ast => (_, defaultSource = 'default', defaultValue) => ast.value !== undefined ? ast : (defaultValue !== undefined ? {
            ...ast,
            value: defaultValue
        } : F.compose(query, deref(sources))(ast, {meta, source: defaultSource})),
        '!': ast => (isAltLookup, altSource, ...args) => {
            let result = ast;
            if (isAltLookup) {
                result = !F.isEmptyValue(altSource) ? F.compose(query, deref(sources))(ast, {
                    meta,
                    source: altSource
                }) : {...result, value: null};
                const [defaultValue] = args;
                result = result.value !== undefined ? result : (
                    defaultValue !== undefined ? {
                        ...result,
                        value: defaultValue
                    } : {
                        ...result, value: null
                    }
                )
            } else {
                result = {
                    ...result,
                    value: (altSource && tagHandlers[altSource]) ? tagHandlers[altSource](ast.value, ...args) : null
                };
            }
            return result;
        }
    };

    let [op, eq, ...app] = ast.operators.constraints;
    app = (eq && eq !== '=') ? [eq, ...app] : app; // if first char is not = put it back with the `application` string
    const args = eq ? F.pipes(bins.split(':'), bins.take(2), lst => F.map(bins.trim, lst))(app.join('')) : [];
    const result = ops[op](ast)(eq === '=', ...args);

    return {...result, '@meta': meta};
};

const constraintsOperator = ({sources, tagHandlers}) => F.composes(constraints({
    sources,
    tagHandlers
}), bins.has('$.operators.constraints'));

const symbol = ({tags, context}) => (ast, {meta = 2} = {}) => {
    const ops = {
        ':': ast => {throw new Error('Not Implemented Yet: [symbol(:)]');},
        '#': ast => tag => {
            const path = F.isEmptyValue(tag) ? jp.stringify(context.path) : jpify(tag);
            jp.value(tags, path, ast.value);
            return {...ast, tag: path};
        }
    };

    const [op, ...tag] = ast.operators.symbol;
    const result = ops[op](ast)(tag.join('').trim());
    return {...result, '@meta': meta};
};

const symbolOperator = ({tags, context}) => F.composes(symbol({tags, context}), bins.has('$.operators.symbol'));

const enumerate = (ast, {meta = 4} = {}) => {
    const ops = {
        '*': ast => ({...ast, value: [...F.iterator(ast.value)]}), //@TODO define or remove, works better in the closing braces }*} as flatten or n-flatten
        '**': ast => ({...ast, value: [...F.iterator(ast.value, {indexed: true, kv: true})]}) // TODO: do scenarios of ** python style k/v pairs expansion fit with jsonpath?
    };

    const [i, ik = ''] = ast.operators.enumerate;
    const result = ops[i + ik](ast);
    return {...result, '@meta': meta};
};

const enumerateOperator = F.composes(enumerate, bins.has('$.operators.enumerate'));

const pipe = ({functions}) => (ast, {meta = 5} = {}) => {
    // console.log('INSIDE PIPE OPERATOR')
    /*
    * example: pipes: { '$1': 'toInt', '$2': 'isEven', '@meta': 3 }
    */
    const pipes = ast.pipes;
    const fnTuples = [...
        F.filter(
            pair => pair[0].startsWith('$'),
            F.iterator(pipes, {indexed: true, kv: true})
        )
    ]
        .sort(sortBy(0));
    // ordered [['$1', 'toInt:arg1:arg2'], ['$2', 'isEven:arg1:arg2']]
    const fnPipeline = F.map(([_, fnExpr]) => {
        const [fnName, ...args] = fnExpr.split(regex.fnArgsSeparator);

        console.log({functions});

        if (!fnName in functions) {
            throw new Error(`could not resolve function name [${fnName}]`)
        }
        /*
        * A function accepting an argument should return a function of arity one that receives the value rendered
        * example: take(n)(data), parseInt(base)(data), etc ...
        */

        /**
         * For functions of arity > 1, the engine supports one slot (only) syntax @TODO: support multiple slots
         * example: equals:100:__
         *
         */
        let phIndex = args.indexOf('__');
        let fn = functions[fnName];

        if (phIndex > 0) {
            args[phIndex] = F.__;
            fn = F.oneslot(functions[fnName]);
        }

        return args.length ? fn(...args) : fn;
    }, fnTuples);

    return {...ast, '@meta': meta, value: F.pipes(...fnPipeline)(ast.value)};
};

const pipeOperator = ({functions}) => F.composes(pipe({functions}), bins.has('$.pipes'));

const applyAll = ({meta, sources, tags, tagHandlers, functions, context, config}) => F.composes(
    pipeOperator({functions}),
    enumerateOperator,
    symbolOperator({tags, context}),
    constraintsOperator({sources, tagHandlers, config}),
    query,
    deref(sources)
);

/**
 * op = [ .+ | .N | >+ | >N | %+ | %N ]
 * .. : lens composition inception
 * >> : for each child, apply transform with leader node
 * %% : zip transform, positional template from leader node renders child template at the same position
 * @param ast
 * @returns {{$inception, $depth: *}}
 */
const inception = options => (ast, enumerable, {meta = 5}={}) => {
    const ops = {
        /**
         * Renders node n in current scope, render n+1 using n as scoped-document, effectively recurring into smaller scopes
         * @param ast
         * @param enumerable
         * @param options
         */
        '.': (ast, enumerable, options) => {
            const {transform} = require('../transform'); // lazy require to break cyclic dependency
            const lens = template => document => transform(template, options)(document);
            const lenses = F.map(lens, enumerable);
            return {...ast, value: F.pipes(...lenses)(ast.value)};
        },
        /**
         * Renders the leader node, use the rendered value as a scoped-document to render the rest of the enumerable as templates
         * @param ast
         * @param enumerable
         * @param options
         */
        '>': (ast, enumerable, options) => {
            const [inceptionNode] = enumerable;
            const {transform} = require('../transform'); // lazy require to break cyclic dependency
            const scopedDocument = transform(inceptionNode, options)(options.sources.origin);
            return F.map(item => transform(item, options)(scopedDocument), enumerable);
        },
        /**
         * Renders the leader node, which yields an array of documents, zip/render the array of templates aligning document(n) with template(n)
         * @param ast
         * @param enumerable
         * @param options
         */
        '%': (ast, enumerable, options) => {
            const [inceptionNode] = enumerable;
            const {transform} = require('../transform'); // lazy require to break cyclic dependency
            const scopedDocument = transform(inceptionNode, options)(options.sources.origin);
            if (!F.isArray(scopedDocument)) throw new Error('Inception Operator [%] should be used for template nodes yielding an array');
            const rest = [...enumerable];
            if (rest.length === 1) {
                // no zip align, apply the rest-template for-each value in document
                return F.map(documentItem => transform(rest[0])(documentItem), scopedDocument);
            } else {
                // zip-align
                const pairsIter = F.zip(rest, scopedDocument);
                return F.map(([template, document]) => transform(template)(document), pairsIter);
            }
        }
    };

    const {$inception, $depth} = ast;
    const opFn = ops[$inception];

    const result = opFn(ast, enumerable, options);
    return result; //enumerable
};

const inceptionPreprocessor = ast => {
    const [op, repeat, ...rest] = ast.operators.inception;
    const $depth = repeat !== op ? (repeat ? parseInt([repeat, ...rest].join(''), 10) : Number.POSITIVE_INFINITY) : rest.length + 1;
    return {...ast, $inception: op, $depth};
};

module.exports = {
    deref,
    query,
    constraints: constraintsOperator,
    symbol: symbolOperator,
    enumerate: enumerateOperator,
    inceptionPreprocessor,
    inception,
    pipe: pipeOperator,
    applyAll,
    sortBy,
};