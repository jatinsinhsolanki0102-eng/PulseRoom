import React from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

export default function ChatSearchBar({ query, count, index, onChange, onNav, onClose }) {
  return (
    <div className="chat-search-bar">
      <Search size={16} className="chat-search-icon" />
      <input
        type="text"
        className="chat-search-input"
        placeholder="Search messages in this chat..."
        value={query}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
      {count > 0 && (
        <span className="chat-search-count">
          {index + 1} of {count}
        </span>
      )}
      {count > 0 && (
        <>
          <button className="action-icon-btn chat-search-nav" title="Previous match" onClick={() => onNav(-1)}>
            <ChevronUp size={16} />
          </button>
          <button className="action-icon-btn chat-search-nav" title="Next match" onClick={() => onNav(1)}>
            <ChevronDown size={16} />
          </button>
        </>
      )}
      <button className="action-icon-btn chat-search-nav" title="Close search" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
