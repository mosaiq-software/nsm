import { Button, ButtonGroup, Flex, TextInput } from '@mantine/core';
import React, { useEffect, useState } from 'react';
import { MdOutlineEdit } from 'react-icons/md';

interface EditableTextInputProps {
    label?: string;
    description?: string;
    value: string;
    placeholder?: string;
    onChange?: (newValue: string) => void;
    orientation?: 'horizontal' | 'vertical';
}
export const EditableTextInput = (props: EditableTextInputProps) => {
    const [editing, setEditing] = useState<boolean>(false);
    const [editedValue, setEditedValue] = useState<string>(props.value);
    const inputRef = React.useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (props.value !== editedValue && !editing) {
            setEditedValue(props.value);
        }
    }, [props.value, editing]);

    const handleEnableEdit = () => {
        setEditing(true);
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    };

    const handleChange = (value: string) => {
        setEditedValue(value);
    };

    const handleSave = () => {
        setEditing(false);
        props.onChange?.(editedValue);
    };

    const handleCancel = () => {
        setEditing(false);
        setEditedValue(props.value);
    };

    return (
        <Flex align="flex-end" direction={props.orientation === 'vertical' ? 'column' : 'row'} gap="sm" wrap="nowrap">
            <TextInput
                ref={inputRef}
                label={props.label}
                description={props.description}
                value={editedValue}
                onChange={(event) => handleChange(event.currentTarget.value)}
                onDoubleClick={handleEnableEdit}
                autoFocus={editing}
                readOnly={!editing}
                placeholder={props.placeholder}
                styles={{
                    input: {
                        borderColor: editing ? 'blue' : 'transparent',
                    },
                }}
                leftSection={editing ? null : <MdOutlineEdit onClick={handleEnableEdit} />}
            />
            {editing && (
                <ButtonGroup>
                    <Button onClick={handleCancel} variant="outline">
                        Cancel
                    </Button>
                    <Button onClick={handleSave} variant="filled">
                        Save
                    </Button>
                </ButtonGroup>
            )}
        </Flex>
    );
};
