import React from 'react';

interface OptionButtonsProps {
  options: string[];
  onOptionClick: (option: string) => void;
  isDarkMode?: boolean;
}

export default function OptionButtons({ options, onOptionClick, isDarkMode = false }: OptionButtonsProps) {
  if (!options || options.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {options.map((option, index) => (
        <button
          key={index}
          onClick={() => onOptionClick(option)}
          className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
            isDarkMode
              ? 'bg-slate-700 text-gray-200 border-slate-600 hover:bg-slate-600 hover:border-slate-500'
              : 'bg-white text-gray-800 border-gray-300 hover:bg-gray-50 hover:border-gray-400'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
