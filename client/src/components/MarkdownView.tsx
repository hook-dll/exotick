import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components = {
  h1: ({ node, ...props }: any) => <h1 className="text-base font-bold mt-3 mb-1" {...props} />,
  h2: ({ node, ...props }: any) => <h2 className="text-sm font-semibold mt-2 mb-1" {...props} />,
  h3: ({ node, ...props }: any) => <h3 className="text-sm font-medium mt-2 mb-0.5" {...props} />,
  p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
  ul: ({ node, ...props }: any) => <ul className="list-disc pl-4 mb-2 space-y-0.5" {...props} />,
  ol: ({ node, ...props }: any) => <ol className="list-decimal pl-4 mb-2 space-y-0.5" {...props} />,
  li: ({ node, ...props }: any) => <li className="text-sm" {...props} />,
  a: ({ node, ...props }: any) => <a className="text-blue-500 underline hover:text-blue-700" target="_blank" rel="noreferrer" {...props} />,
  img: ({ node, ...props }: any) => <img className="max-w-full rounded my-2 border" {...props} />,
  code: ({ node, className, children, ...props }: any) => {
    const isBlock = /language-/.test(className || '');
    return isBlock
      ? <pre className="bg-gray-100 p-2 rounded text-xs overflow-x-auto my-2"><code className={className} {...props}>{children}</code></pre>
      : <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  blockquote: ({ node, ...props }: any) => <blockquote className="border-l-4 border-gray-200 pl-3 text-gray-500 my-2 italic" {...props} />,
  table: ({ node, ...props }: any) => <table className="text-xs border-collapse w-full my-2" {...props} />,
  th: ({ node, ...props }: any) => <th className="border border-gray-200 px-2 py-1 bg-gray-50 font-medium text-left" {...props} />,
  td: ({ node, ...props }: any) => <td className="border border-gray-200 px-2 py-1" {...props} />,
  hr: ({ node, ...props }: any) => <hr className="my-3 border-gray-200" {...props} />,
};

export default function MarkdownView({ content }: { content: string }) {
  return (
    <div className="text-sm text-gray-700 leading-relaxed break-words">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
